import { describe, expect, it, vi } from "vitest";
import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type CloudFormationClient,
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
  deploy, getStatus, teardown, TEMPLATE_KEY_TAG, LAMBDA_KEY_TAG, deployBucketName,
} from "./stack";
import { lambdaCodeKey, templateKey } from "./generated/backend-bundle";
import { TAG_APP, TAG_ACCOUNT, TAG_CONNECTION } from "./tags";

const ctx = { accountId: "111122223333", connectionId: "conn-1" };
const REGION = "eu-west-1";
const DEPLOY_BUCKET = deployBucketName(ctx.accountId, REGION);

/** A CloudFormation whose DescribeStacks answers with the given statuses, in order. */
function fakeCfn(script: { describe?: (unknown | Error)[]; events?: unknown[]; onSend?: (cmd: unknown) => unknown }) {
  const sent: unknown[] = [];
  let i = 0;
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof DescribeStacksCommand) {
        const next = script.describe?.[Math.min(i++, (script.describe?.length ?? 1) - 1)];
        if (next instanceof Error) throw next;
        return next ?? { Stacks: [] };
      }
      const handled = script.onSend?.(cmd); // may throw (simulating AccessDenied) or override
      if (handled !== undefined) return handled;
      if (cmd instanceof DescribeStackEventsCommand) return { StackEvents: script.events ?? [] };
      return {};
    }),
  } as unknown as CloudFormationClient;
  return { client, sent };
}

/**
 * An S3 test double. By default every bucket exists and is empty; `missingBuckets`
 * makes HeadBucket/List/Delete report NoSuchBucket for those names, and `objects`
 * seeds ListObjectsV2 pages (drained by a DeleteObjects call, like the real thing).
 */
function fakeS3(opts: { missingBuckets?: string[]; objects?: Record<string, string[]>; onSend?: (cmd: unknown) => unknown } = {}) {
  const sent: unknown[] = [];
  const missing = new Set(opts.missingBuckets ?? []);
  const objects = new Map(Object.entries(opts.objects ?? {}));
  const noSuchBucket = () => Object.assign(new Error("bucket gone"), { name: "NoSuchBucket" });
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      const handled = opts.onSend?.(cmd);
      if (handled !== undefined) return handled;
      const bucket = (cmd as { input?: { Bucket?: string } }).input?.Bucket ?? "";
      if (cmd instanceof HeadBucketCommand) {
        if (missing.has(bucket)) throw Object.assign(new Error("not found"), { name: "NotFound" });
        return {};
      }
      if (cmd instanceof CreateBucketCommand) {
        missing.delete(bucket);
        return {};
      }
      if (cmd instanceof ListObjectsV2Command) {
        if (missing.has(bucket)) throw noSuchBucket();
        const keys = objects.get(bucket) ?? [];
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      if (cmd instanceof DeleteObjectsCommand) {
        if (missing.has(bucket)) throw noSuchBucket();
        objects.set(bucket, []);
        return {};
      }
      if (cmd instanceof DeleteBucketCommand) {
        if (missing.has(bucket)) throw noSuchBucket();
        missing.add(bucket);
        return {};
      }
      return {};
    }),
  } as unknown as S3Client;
  return { client, sent };
}

const notFound = Object.assign(new Error("Stack with id CrewPoppyStack does not exist"), {
  name: "ValidationError",
});
const stackWith = (StackStatus: string, Tags: { Key: string; Value: string }[] = []) => ({
  Stacks: [{ StackStatus, Tags }],
});

// waitUntilStackDeleteComplete polls the real client; stub the module so the delete
// paths don't sleep through a waiter in unit tests.
vi.mock("@aws-sdk/client-cloudformation", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-cloudformation")>(
    "@aws-sdk/client-cloudformation",
  );
  return { ...actual, waitUntilStackDeleteComplete: vi.fn(async () => ({ state: "SUCCESS" })) };
});

describe("getStatus — state comes from AWS, never from memory (AGENTS.md §5)", () => {
  it("reports 'none' when nothing is deployed", async () => {
    const { client } = fakeCfn({ describe: [notFound] });
    const s = await getStatus(client, REGION);
    expect(s.phase).toBe("none");
    expect(s.inProgress).toBe(false);
    expect(s.tableName).toBeUndefined();
  });

  it("reports a create in flight as in-progress, so a returning user re-attaches to it", async () => {
    const { client } = fakeCfn({ describe: [stackWith("CREATE_IN_PROGRESS")] });
    const s = await getStatus(client, REGION);
    expect(s.phase).toBe("deploying");
    expect(s.inProgress).toBe(true);
  });

  it("reports a delete in flight as removing, not as a failed deploy", async () => {
    const { client } = fakeCfn({ describe: [stackWith("DELETE_IN_PROGRESS")] });
    const s = await getStatus(client, REGION);
    expect(s.phase).toBe("removing");
    expect(s.inProgress).toBe(true);
  });

  it("surfaces the table and runner only once the stack is actually ready", async () => {
    const { client } = fakeCfn({ describe: [stackWith("CREATE_COMPLETE")] });
    const s = await getStatus(client, REGION);
    expect(s.phase).toBe("ready");
    expect(s.tableName).toBe("CrewPoppyData");
    expect(s.runnerFunctionName).toBe("CrewPoppyRunner");
  });

  it("turns a rollback into one calm sentence, not a raw status", async () => {
    const { client } = fakeCfn({ describe: [stackWith("ROLLBACK_COMPLETE")] });
    const s = await getStatus(client, REGION);
    expect(s.phase).toBe("failed");
    expect(s.message).toMatch(/try again/i);
    expect(s.message).not.toMatch(/ROLLBACK/);
    expect(s.stackStatus).toBe("ROLLBACK_COMPLETE"); // still available for the details view
  });

  it("surfaces the ROOT-CAUSE failure reason, not the rollback boilerplate that buries it", async () => {
    // Events come back newest-first: the stack-level rollback and a cancellation on
    // top, the real trigger (an AccessDenied) underneath. We want the trigger.
    const { client } = fakeCfn({
      describe: [stackWith("ROLLBACK_COMPLETE")],
      events: [
        { ResourceStatus: "ROLLBACK_COMPLETE", ResourceStatusReason: undefined },
        { ResourceStatus: "CREATE_FAILED", ResourceStatusReason: "Resource creation cancelled" },
        {
          ResourceStatus: "CREATE_FAILED",
          ResourceStatusReason:
            "User is not authorized to perform: iam:CreateRole (AccessDenied)",
        },
      ],
    });
    const s = await getStatus(client, REGION);
    expect(s.failureReason).toMatch(/iam:CreateRole/);
    expect(s.message).toMatch(/try again/i); // the calm line stays for the user
  });

  it("spots a stack running an older template than this build ships", async () => {
    const { client } = fakeCfn({
      describe: [stackWith("CREATE_COMPLETE", [{ Key: TEMPLATE_KEY_TAG, Value: "template-oldoldoldoldold" }])],
    });
    const s = await getStatus(client, REGION);
    expect(s.updateAvailable).toBe(true);
    expect(s.deployedTemplateKey).toBe("template-oldoldoldoldold");
  });

  it("does not claim an update when BOTH halves already match", async () => {
    const { client } = fakeCfn({
      describe: [
        stackWith("CREATE_COMPLETE", [
          { Key: TEMPLATE_KEY_TAG, Value: templateKey },
          { Key: LAMBDA_KEY_TAG, Value: lambdaCodeKey },
        ]),
      ],
    });
    expect((await getStatus(client, REGION)).updateAvailable).toBe(false);
  });

  // 🪤 The live one (2026-07-27). The heartbeat was a Lambda-only change, so the template
  // key still matched and the app reported "up to date" while the deployed runner was two
  // changes behind — and the diagnostic we were both reading came from code that had
  // never been deployed.
  it("claims an update when only the RUNNER CODE is stale", async () => {
    const { client } = fakeCfn({
      describe: [
        stackWith("CREATE_COMPLETE", [
          { Key: TEMPLATE_KEY_TAG, Value: templateKey },
          { Key: LAMBDA_KEY_TAG, Value: "lambda-code-something-older.zip" },
        ]),
      ],
    });
    const s = await getStatus(client, REGION);
    expect(s.updateAvailable).toBe(true);
    expect(s.deployedLambdaKey).toBe("lambda-code-something-older.zip");
  });

  it("offers the update when the stack predates the runner tag entirely", async () => {
    // Unknown is not the same as current. Offering a redundant update is free; running
    // old code while insisting it is current is what just cost hours.
    const { client } = fakeCfn({
      describe: [stackWith("CREATE_COMPLETE", [{ Key: TEMPLATE_KEY_TAG, Value: templateKey }])],
    });
    expect((await getStatus(client, REGION)).updateAvailable).toBe(true);
  });

  it("records BOTH versions on every deploy, so the next read can compare them", async () => {
    const { client: cfn, sent } = fakeCfn({ describe: [notFound] });
    const { client: s3 } = fakeS3({});
    await deploy(cfn, s3, ctx, REGION);
    const create = sent.find((c) => c instanceof CreateStackCommand) as CreateStackCommand;
    const tags = create.input.Tags ?? [];
    expect(tags.find((t) => t.Key === TEMPLATE_KEY_TAG)?.Value).toBe(templateKey);
    expect(tags.find((t) => t.Key === LAMBDA_KEY_TAG)?.Value).toBe(lambdaCodeKey);
  });
});

describe("deploy — the embedded-artifact pipeline", () => {
  it("creates the deploy bucket (tagged) and uploads the zip before touching CloudFormation", async () => {
    const { client: cfn } = fakeCfn({ describe: [notFound] });
    const { client: s3, sent } = fakeS3({ missingBuckets: [DEPLOY_BUCKET] });
    await deploy(cfn, s3, ctx, REGION);

    const create = sent.find((c) => c instanceof CreateBucketCommand) as CreateBucketCommand;
    expect(create.input.Bucket).toBe(DEPLOY_BUCKET);
    // Outside the stack ⇒ MUST carry the three tags itself or it leaks (AGENTS.md §4).
    const tagging = sent.find((c) => c instanceof PutBucketTaggingCommand) as PutBucketTaggingCommand;
    const tagKeys = (tagging.input.Tagging?.TagSet ?? []).map((t) => t.Key);
    expect(tagKeys).toEqual(expect.arrayContaining([TAG_ACCOUNT, TAG_APP, TAG_CONNECTION]));
    const put = sent.find((c) => c instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.Key).toBe(lambdaCodeKey);
  });

  it("reuses an existing deploy bucket without recreating it", async () => {
    const { client: cfn } = fakeCfn({ describe: [notFound] });
    const { client: s3, sent } = fakeS3();
    await deploy(cfn, s3, ctx, REGION);
    expect(sent.find((c) => c instanceof CreateBucketCommand)).toBeUndefined();
    expect(sent.find((c) => c instanceof PutObjectCommand)).toBeDefined();
  });

  it("creates the stack with attribution tags, the code parameters, and NAMED_IAM acknowledged", async () => {
    const { client: cfn, sent } = fakeCfn({ describe: [notFound] });
    const { client: s3 } = fakeS3();
    const r = await deploy(cfn, s3, ctx, REGION);
    expect(r.operation).toBe("CREATE");

    const create = sent.find((c) => c instanceof CreateStackCommand) as CreateStackCommand;
    const tags = Object.fromEntries((create.input.Tags ?? []).map((t) => [t.Key, t.Value]));
    // Without these three the host can neither attribute nor tear down what we made.
    expect(tags[TAG_ACCOUNT]).toBe("111122223333");
    expect(tags[TAG_APP]).toBe("com.crewpoppy.desktop");
    expect(tags[TAG_CONNECTION]).toBe("conn-1");
    expect(tags[TEMPLATE_KEY_TAG]).toBe(templateKey);

    const params = Object.fromEntries(
      (create.input.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue]),
    );
    expect(params.LambdaCodeBucket).toBe(DEPLOY_BUCKET);
    expect(params.LambdaCodeKey).toBe(lambdaCodeKey);
    expect(create.input.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
  });

  it("refuses to deploy an untrackable footprint when there's no connection", async () => {
    const { client: cfn, sent } = fakeCfn({ describe: [notFound] });
    const { client: s3, sent: s3Sent } = fakeS3();
    await expect(deploy(cfn, s3, { accountId: "", connectionId: "" }, REGION)).rejects.toThrow(/connected/i);
    expect(sent.find((c) => c instanceof CreateStackCommand)).toBeUndefined();
    expect(s3Sent).toHaveLength(0); // not even the bucket
  });

  it("updates an existing stack", async () => {
    const { client: cfn } = fakeCfn({ describe: [stackWith("CREATE_COMPLETE")] });
    const { client: s3 } = fakeS3();
    expect((await deploy(cfn, s3, ctx, REGION)).operation).toBe("UPDATE");
  });

  it("treats 'no updates to perform' as NO_CHANGE, not an error", async () => {
    const { client: cfn } = fakeCfn({
      describe: [stackWith("CREATE_COMPLETE")],
      onSend: (cmd) => {
        if (cmd instanceof UpdateStackCommand) throw new Error("No updates are to be performed.");
        return {};
      },
    });
    const { client: s3 } = fakeS3();
    expect((await deploy(cfn, s3, ctx, REGION)).operation).toBe("NO_CHANGE");
  });

  it("deletes and recreates a stack stuck in ROLLBACK_COMPLETE (it cannot be updated)", async () => {
    const { client: cfn, sent } = fakeCfn({ describe: [stackWith("ROLLBACK_COMPLETE")] });
    const { client: s3 } = fakeS3();
    const r = await deploy(cfn, s3, ctx, REGION);
    expect(r.operation).toBe("RECREATE");
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeDefined();
    expect(sent.find((c) => c instanceof CreateStackCommand)).toBeDefined();
  });

  it("lets a real AWS failure surface rather than swallowing it", async () => {
    const { client: cfn } = fakeCfn({
      describe: [stackWith("CREATE_COMPLETE")],
      onSend: (cmd) => {
        if (cmd instanceof UpdateStackCommand) throw new Error("AccessDenied: not authorized");
        return {};
      },
    });
    const { client: s3 } = fakeS3();
    await expect(deploy(cfn, s3, ctx, REGION)).rejects.toThrow(/AccessDenied/);
  });
});

describe("teardown — must leave no trace, and must be idempotent (AGENTS.md §4)", () => {
  it("empties the workspace bucket, deletes the stack, then removes the deploy bucket", async () => {
    const workspace = `crewpoppy-workspace-${ctx.accountId}-${REGION}`;
    const { client: cfn, sent } = fakeCfn({ describe: [stackWith("CREATE_COMPLETE")] });
    const { client: s3, sent: s3Sent } = fakeS3({
      objects: { [workspace]: ["agents/emma/notes.txt"], [DEPLOY_BUCKET]: [lambdaCodeKey] },
    });
    const r = await teardown(cfn, s3, ctx.accountId, REGION);

    expect(r.removed).toEqual(["CrewPoppyStack", DEPLOY_BUCKET]);
    // Workspace bucket emptied (CloudFormation can't delete a non-empty bucket)…
    const emptied = s3Sent.filter((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand[];
    expect(emptied.map((c) => c.input.Bucket)).toEqual(expect.arrayContaining([workspace, DEPLOY_BUCKET]));
    // …the stack deleted…
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeDefined();
    // …and the out-of-stack deploy bucket actually deleted, not just emptied.
    const deleted = s3Sent.find((c) => c instanceof DeleteBucketCommand) as DeleteBucketCommand;
    expect(deleted.input.Bucket).toBe(DEPLOY_BUCKET);
  });

  it("succeeds with nothing to do when everything is already gone (it may run twice)", async () => {
    const { client: cfn, sent } = fakeCfn({ describe: [notFound] });
    const { client: s3 } = fakeS3({ missingBuckets: [DEPLOY_BUCKET] });
    const r = await teardown(cfn, s3, ctx.accountId, REGION);
    expect(r.removed).toEqual([]);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeUndefined();
  });

  it("still removes the deploy bucket when the stack is already gone (partial re-run)", async () => {
    const { client: cfn } = fakeCfn({ describe: [notFound] });
    const { client: s3, sent: s3Sent } = fakeS3({ objects: { [DEPLOY_BUCKET]: [lambdaCodeKey] } });
    const r = await teardown(cfn, s3, ctx.accountId, REGION);
    expect(r.removed).toEqual([DEPLOY_BUCKET]);
    expect(s3Sent.find((c) => c instanceof DeleteBucketCommand)).toBeDefined();
  });

  it("waits out a delete that's already running instead of asking for it twice", async () => {
    const { client: cfn, sent } = fakeCfn({ describe: [stackWith("DELETE_IN_PROGRESS")] });
    const { client: s3 } = fakeS3({ missingBuckets: [DEPLOY_BUCKET] });
    const r = await teardown(cfn, s3, ctx.accountId, REGION);
    expect(sent.filter((c) => c instanceof DeleteStackCommand)).toHaveLength(0);
    expect(r.removed).toEqual(["CrewPoppyStack"]);
  });

  it("tears down a failed stack too — a rollback still leaves resources behind", async () => {
    const { client: cfn, sent } = fakeCfn({ describe: [stackWith("ROLLBACK_COMPLETE")] });
    const { client: s3 } = fakeS3({ missingBuckets: [DEPLOY_BUCKET] });
    await teardown(cfn, s3, ctx.accountId, REGION);
    expect(sent.find((c) => c instanceof DeleteStackCommand)).toBeDefined();
  });

  it("tolerates the workspace bucket never having been created (failed first deploy)", async () => {
    const workspace = `crewpoppy-workspace-${ctx.accountId}-${REGION}`;
    const { client: cfn } = fakeCfn({ describe: [stackWith("ROLLBACK_COMPLETE")] });
    const { client: s3 } = fakeS3({ missingBuckets: [workspace, DEPLOY_BUCKET] });
    const r = await teardown(cfn, s3, ctx.accountId, REGION);
    expect(r.removed).toEqual(["CrewPoppyStack"]);
  });
});
