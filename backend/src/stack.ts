// The stack lifecycle: deploy, report live status, tear down.
//
// The template AND the agent-runner zip are EMBEDDED in this binary (backend-bundle.ts,
// generated from infra/ + lambdas/), so the user never needs cdk, node, or npm. The
// template is small enough to pass inline as TemplateBody; the Lambda zip is the one
// thing CloudFormation insists on fetching from S3, so deploy first ensures a TAGGED
// deploy bucket (crewpoppy-deploy-<account>-<region>) and uploads the content-addressed
// zip there. That bucket is the ONLY resource outside the stack — created tagged so the
// host can see it, removed by our teardown hook (AGENTS.md §4 "outside your stack").
//
// Everything here takes its AWS clients by injection so the lifecycle logic is
// unit-testable without touching AWS.

import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackDeleteComplete,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketTaggingCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  lambdaCodeKey,
  lambdaZipBase64,
  runnerFunctionName,
  stackName,
  tableName,
  templateJson,
  templateKey,
  sourceCommit,
} from "./generated/backend-bundle";
import { stackTags, type AttributionContext } from "./tags";

export { lambdaCodeKey, runnerFunctionName, stackName, tableName, templateKey };

/** The bucket the Lambda zip is served from — the one resource outside the stack. */
export function deployBucketName(accountId: string, region: string): string {
  return `crewpoppy-deploy-${accountId}-${region}`;
}

/** The per-agent workspace bucket the STACK creates (mirrors infra/src/template.ts). */
export function workspaceBucketName(accountId: string, region: string): string {
  return `crewpoppy-workspace-${accountId}-${region}`;
}

/** How the UI should treat the stack right now — derived from AWS, never remembered. */
export type DeploymentPhase = "none" | "deploying" | "ready" | "removing" | "failed";

export interface DeploymentStatus {
  phase: DeploymentPhase;
  /** The raw CloudFormation StackStatus, for the technical/details view. */
  stackStatus?: string;
  stackName: string;
  region: string;
  tableName?: string;
  runnerFunctionName?: string;
  /** True while AWS is still working — the UI polls on this (AGENTS.md §5). */
  inProgress: boolean;
  /** One calm sentence for the user when something went wrong. */
  message?: string;
  /** The raw CloudFormation reason for a failure — for the technical details view. */
  failureReason?: string;
  /** The template this deployment actually runs, vs. the one this build ships. */
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  /** The agent-runner code it actually runs, vs. the one this build ships. */
  deployedLambdaKey?: string;
  currentLambdaKey: string;
  updateAvailable: boolean;
}

export type StackOperation = "CREATE" | "UPDATE" | "NO_CHANGE" | "RECREATE";

/** The tag recording WHICH template a stack runs — the NO_CHANGE cross-check. */
export const TEMPLATE_KEY_TAG = "crewpoppy:templateKey";

/**
 * The tag recording WHICH agent-runner code a stack runs.
 *
 * 🪤 LIVE FAILURE (2026-07-27): "update available" compared the TEMPLATE key only, so a
 * change to the Lambda alone — the ticker's heartbeat, in this case — was completely
 * invisible. The app told the founder there was nothing to apply while the deployed
 * runner was two changes behind, and the diagnostic we were both reading was produced by
 * code that had never been deployed. Hours went into that.
 *
 * The template and the code are two independently versioned things, so BOTH have to be
 * compared. This is the same family as CLAUDE.md gotcha #1 (a stale sidecar masking
 * Lambda changes) — one level further out.
 */
export const LAMBDA_KEY_TAG = "crewpoppy:lambdaCodeKey";

/** CloudFormation statuses that mean "AWS is mid-operation, poll me". */
const IN_PROGRESS = /_IN_PROGRESS$/;
/** Statuses that mean the last operation left the stack unusable. */
const FAILED = /(ROLLBACK_COMPLETE|ROLLBACK_FAILED|_FAILED)$/;

/** True when DescribeStacks says the stack simply isn't there. */
function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === "ValidationError" && /does not exist/i.test(err?.message ?? "");
}

/** True when S3 says the bucket is already gone (teardown idempotency). */
function isNoSuchBucket(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? "";
  return name === "NoSuchBucket" || name === "NotFound";
}

/** The stack as AWS currently has it, or null if it doesn't exist. */
async function describe(cfn: CloudFormationClient, name: string): Promise<Stack | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return out.Stacks?.[0] ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function phaseOf(status: string | undefined): DeploymentPhase {
  if (!status) return "none";
  if (status.startsWith("DELETE") && IN_PROGRESS.test(status)) return "removing";
  if (IN_PROGRESS.test(status)) return "deploying";
  if (FAILED.test(status)) return "failed";
  if (status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE") return "ready";
  return "deploying";
}

/**
 * Read the live deployment state straight from CloudFormation.
 *
 * This is the whole of AGENTS.md §5: the UI holds no memory of a deploy. It calls this
 * on every mount and derives where the user is from what's really in their account, so
 * leaving mid-deploy and coming back lands on live progress rather than a dead spinner.
 */
export async function getStatus(cfn: CloudFormationClient, region: string): Promise<DeploymentStatus> {
  const stack = await describe(cfn, stackName);
  const stackStatus = stack?.StackStatus;
  const phase = phaseOf(stackStatus);
  const deployedTemplateKey = stack?.Tags?.find((t) => t.Key === TEMPLATE_KEY_TAG)?.Value;
  const deployedLambdaKey = stack?.Tags?.find((t) => t.Key === LAMBDA_KEY_TAG)?.Value;

  // On a failure, pull the actual reason from the stack's events so the details view
  // shows WHY (e.g. an AccessDenied on a specific action), not just "it rolled back".
  const failureReason = phase === "failed" ? await firstFailureReason(cfn) : undefined;

  return {
    phase,
    stackStatus,
    stackName,
    region,
    tableName: phase === "ready" ? tableName : undefined,
    runnerFunctionName: phase === "ready" ? runnerFunctionName : undefined,
    inProgress: !!stackStatus && IN_PROGRESS.test(stackStatus),
    message: phase === "failed" ? failureMessage(stackStatus) : undefined,
    failureReason,
    deployedTemplateKey,
    deployedLambdaKey,
    currentTemplateKey: templateKey,
    currentLambdaKey: lambdaCodeKey,
    // EITHER half being stale means an update is waiting. A stack deployed before the
    // lambda tag existed reports no key at all — and that is treated as "unknown, so
    // offer it", because the alternative is what just happened: silently running old
    // code while the app insists it is current. Applying a redundant update is free.
    updateAvailable:
      (!!deployedTemplateKey && deployedTemplateKey !== templateKey) ||
      deployedLambdaKey !== lambdaCodeKey,
  };
}

/**
 * The raw reason CloudFormation gives for the first resource that failed — the
 * root-cause event, which the later CREATE_FAILED/ROLLBACK noise buries. Read-only,
 * best-effort: any error yields undefined rather than masking the failure itself.
 */
async function firstFailureReason(cfn: CloudFormationClient): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    // Events are newest-first; the earliest *_FAILED with a reason is the trigger.
    const failures = (out.StackEvents ?? []).filter(
      (e) =>
        e.ResourceStatus?.endsWith("_FAILED") &&
        e.ResourceStatusReason &&
        !/resource creation cancelled/i.test(e.ResourceStatusReason),
    );
    const root = failures[failures.length - 1];
    return root?.ResourceStatusReason;
  } catch {
    return undefined;
  }
}

function failureMessage(status: string | undefined): string {
  if (status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED") {
    return "The last setup attempt didn't finish and AWS undid it. You can safely try again.";
  }
  return "Something went wrong in your AWS account during the last change. You can try again, or remove CrewPoppy and start fresh.";
}

export interface DeployResult {
  operation: StackOperation;
  stackName: string;
  templateKey: string;
  lambdaCodeKey: string;
}

/**
 * Ensure the tagged deploy bucket exists and holds the embedded agent-runner zip under
 * its content-addressed key. Idempotent: an existing bucket is re-tagged (harmless),
 * and re-uploading identical bytes under the same key is a no-op in effect.
 */
async function ensureCodeUploaded(s3: S3Client, ctx: AttributionContext, region: string): Promise<string> {
  const bucket = deployBucketName(ctx.accountId, region);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    // us-east-1 rejects an explicit LocationConstraint; everywhere else requires it.
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
      }),
    );
  }
  // Tag on every deploy, not just creation: the bucket outlives connections, and the
  // sweep must always see current attribution (untagged = an invisible leak).
  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucket,
      Tagging: { TagSet: stackTags({ ...ctx, sourceCommit: sourceCommit || undefined }) },
    }),
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: lambdaCodeKey,
      Body: Buffer.from(lambdaZipBase64, "base64"),
      ContentType: "application/zip",
    }),
  );
  return bucket;
}

/**
 * Create or update the stack. Returns as soon as AWS accepts the request — the work
 * runs in the background (AGENTS.md §5); poll getStatus for completion.
 */
export async function deploy(
  cfn: CloudFormationClient,
  s3: S3Client,
  ctx: AttributionContext,
  region: string,
): Promise<DeployResult> {
  // The stack MUST carry attribution or AgentsPoppy can neither show nor tear down
  // what we made — so refuse rather than deploy an untrackable footprint.
  if (!ctx.accountId || !ctx.connectionId) {
    throw new Error(
      "CrewPoppy isn't connected to your AWS account yet. Approve it in AgentsPoppy, then try again.",
    );
  }
  const codeBucket = await ensureCodeUploaded(s3, ctx, region);

  const Tags = [
    ...stackTags({ ...ctx, sourceCommit: sourceCommit || undefined }),
    { Key: TEMPLATE_KEY_TAG, Value: templateKey },
    // Recorded so the next status read can tell whether the RUNNER is current, not just
    // the template — the two version independently.
    { Key: LAMBDA_KEY_TAG, Value: lambdaCodeKey },
  ];
  const args = {
    StackName: stackName,
    TemplateBody: templateJson,
    Parameters: [
      { ParameterKey: "LambdaCodeBucket", ParameterValue: codeBucket },
      { ParameterKey: "LambdaCodeKey", ParameterValue: lambdaCodeKey },
      // Cognito pools sit outside CloudFormation's stack-tag propagation, so the
      // template stamps these two into UserPoolTags itself (infra/src/template.ts).
      { ParameterKey: "AttributionAccount", ParameterValue: ctx.accountId },
      { ParameterKey: "AttributionConnection", ParameterValue: ctx.connectionId },
    ],
    // The template creates a NAMED role (CrewPoppyRunnerRole) — CloudFormation demands
    // this explicit acknowledgement before it will create IAM resources.
    Capabilities: ["CAPABILITY_NAMED_IAM" as const],
    Tags,
  };

  const existing = await describe(cfn, stackName);
  const status = existing?.StackStatus;

  // A previous failed create leaves ROLLBACK_COMPLETE: it can't be updated, and
  // creating over it fails until it's fully gone. Delete, wait, recreate.
  if (status === "ROLLBACK_COMPLETE" || status === "REVIEW_IN_PROGRESS") {
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 300 }, { StackName: stackName });
    await cfn.send(new CreateStackCommand(args));
    return { operation: "RECREATE", stackName, templateKey, lambdaCodeKey };
  }

  if (!status) {
    await cfn.send(new CreateStackCommand(args));
    return { operation: "CREATE", stackName, templateKey, lambdaCodeKey };
  }

  try {
    await cfn.send(new UpdateStackCommand(args));
    return { operation: "UPDATE", stackName, templateKey, lambdaCodeKey };
  } catch (e) {
    // Not an error: the account already runs exactly this template + code.
    if (/No updates are to be performed/i.test((e as Error).message ?? "")) {
      return { operation: "NO_CHANGE", stackName, templateKey, lambdaCodeKey };
    }
    throw e;
  }
}

/** Delete every object in a bucket, then the bucket. Already-gone is success. */
async function emptyAndDeleteBucket(s3: S3Client, bucket: string): Promise<boolean> {
  try {
    for (;;) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length === 0) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      if (!page.IsTruncated) break;
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    return true;
  } catch (e) {
    if (isNoSuchBucket(e)) return false;
    throw e;
  }
}

export interface TeardownResult {
  /** What we actually asked AWS to remove (empty when there was nothing left). */
  removed: string[];
}

/**
 * The teardown hook (AGENTS.md §4). The host POSTs this at the START of teardown, then
 * deletes our stack itself — but certification runs with the host's residual cleanup
 * OFF, so this must do the real work on its own.
 *
 * MUST be idempotent: it can run more than once, including after a partial teardown,
 * and "already gone" is a success, not an error. Order:
 *   1. Empty the workspace bucket — CloudFormation refuses to delete a non-empty
 *      bucket, and by teardown time agents may have written files there.
 *   2. Delete the stack and wait for DELETE_COMPLETE.
 *   3. Empty + delete the deploy bucket — the one resource outside the stack.
 */
export async function teardown(
  cfn: CloudFormationClient,
  s3: S3Client,
  accountId: string,
  region: string,
): Promise<TeardownResult> {
  const removed: string[] = [];

  const stack = await describe(cfn, stackName);
  if (stack) {
    // Empty (but don't delete) the in-stack workspace bucket so the stack delete can
    // remove it. NoSuchBucket just means the stack never finished creating it.
    const workspace = workspaceBucketName(accountId, region);
    try {
      for (;;) {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: workspace }));
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length === 0) break;
        await s3.send(new DeleteObjectsCommand({ Bucket: workspace, Delete: { Objects: keys, Quiet: true } }));
        if (!page.IsTruncated) break;
      }
    } catch (e) {
      if (!isNoSuchBucket(e)) throw e;
    }

    if (stack.StackStatus !== "DELETE_IN_PROGRESS") {
      await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    }
    // Wait for the delete to actually land: returning early would report success while
    // the table still exists, and certification's tag sweep would (correctly) find it.
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 600 }, { StackName: stackName });
    removed.push(stackName);
  }

  if (await emptyAndDeleteBucket(s3, deployBucketName(accountId, region))) {
    removed.push(deployBucketName(accountId, region));
  }

  return { removed };
}
