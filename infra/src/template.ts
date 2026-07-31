// CrewPoppy's CloudFormation template, authored as typed TypeScript.
//
// WHY NOT CDK: MailPoppy's generator shells out to `cdk synth` at build time. Our P0
// footprint — one table, one bucket, one role, one Lambda, one log group — is small
// enough to author directly, which removes the cdk dependency and the synth step from
// the build (the TrafficPoppy precedent). The output is the same thing either way: an
// asset-free template JSON that scripts/build-backend-bundle.mjs embeds into the
// sidecar. Recorded as an implementation decision in DESIGN.md §2.
//
// EVERYTHING LIVES IN THIS ONE STACK except the deploy bucket the Lambda zip is served
// from (S3-hosted code is how CloudFormation wants Lambda code delivered; the sidecar
// creates that bucket tagged, and the teardown hook removes it — AGENTS.md §4 "outside
// your stack"). Nothing gets DeletionPolicy: Retain, and deletion protection stays off —
// both would make our own teardown fail.

import { TICK_MINUTES } from "@crewpoppy/shared";

/** The one stack we deploy. The manifest's cloudformation grant is scoped to this exact name. */
export const STACK_NAME = "CrewPoppyStack";

/**
 * The one table. Single-table design: agent definitions, per-agent memory, run
 * transcripts and run checkpoints are all items behind a pk/sk pair (DESIGN.md §3, §5).
 * A fixed name (rather than a CloudFormation-generated one) because the owner's own
 * tools may read it — agents are "just data in your account" (DESIGN.md §3b) — and it
 * matches the manifest's `CrewPoppy*` dynamodb scope.
 */
export const TABLE_NAME = "CrewPoppyData";

/**
 * The attribute holding a row's expiry. Declared from P0 so the rows that MUST age out
 * (ask_user questions that were never answered, run checkpoints — DESIGN.md §5's "an
 * unanswered question expires the run gracefully") are expirable from the moment the
 * table exists, not bolted on by a later stack update that could silently fail.
 */
export const TTL_ATTRIBUTE = "expiresAt";

/** The agent-runner Lambda (empty at P0; the P1 agentic loop lands in lambdas/src/agent-runner.ts). */
export const RUNNER_FUNCTION_NAME = "CrewPoppyRunner";

/** The runner's execution role — the manifest's iam grant is name-scoped to CrewPoppy*. */
export const RUNNER_ROLE_NAME = "CrewPoppyRunnerRole";

/** The single EventBridge rule that wakes the runner to check for due schedules (§5b). */
export const TICK_RULE_NAME = "CrewPoppyTick";

/** The email-approval endpoint (§15e) — internet-facing, token-locked. */
export const APPROVAL_FUNCTION_NAME = "CrewPoppyApproval";
export const APPROVAL_ROLE_NAME = "CrewPoppyApprovalRole";

/** The mobile door (§15h M1) — internet-facing, Cognito-locked. */
export const MOBILE_API_FUNCTION_NAME = "CrewPoppyMobileApi";
export const MOBILE_API_ROLE_NAME = "CrewPoppyMobileApiRole";
export const MOBILE_USER_POOL_NAME = "CrewPoppyMobile";

/**
 * The per-agent workspace bucket (DESIGN.md §3: each agent's files live under its own
 * prefix; the dispatcher enforces the prefix boundary server-side from P2). Bucket names
 * are global + lowercase, so the account id and region are spliced in by CloudFormation.
 */
export const WORKSPACE_BUCKET_SUB = "crewpoppy-workspace-${AWS::AccountId}-${AWS::Region}";

export interface CfnTemplate {
  AWSTemplateFormatVersion: string;
  Description: string;
  Parameters: Record<string, unknown>;
  Resources: Record<string, unknown>;
  Outputs: Record<string, unknown>;
}

/**
 * Build the template. Pure — same input, same bytes — so the content-addressed hash the
 * build script derives from it is stable across machines.
 *
 * The Lambda code arrives via the LambdaCodeBucket/LambdaCodeKey parameters (MailPoppy's
 * asset-free pattern): the sidecar uploads the content-addressed zip it embeds, then
 * passes the bucket/key here. A code change = a new key = a real stack update — never a
 * silent in-place mutation.
 */
export function buildTemplate(): CfnTemplate {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "CrewPoppy — task-specific AI agents that run entirely in your own AWS.",
    Parameters: {
      LambdaCodeBucket: {
        Type: "String",
        Description: "The (tagged, CrewPoppy-created) bucket holding the agent-runner code zip.",
      },
      LambdaCodeKey: {
        Type: "String",
        Description: "Content-addressed key of the agent-runner code zip.",
      },
      // Cognito user pools are OUTSIDE CloudFormation's stack-tag propagation (their tag
      // property is a map, not the standard Tags list, and CFN skips those) — so the two
      // per-install attribution values arrive as parameters and are stamped explicitly in
      // UserPoolTags. Without this the pool is invisible to the host's tag sweep: an
      // orphan-in-waiting and a certify failure.
      AttributionAccount: {
        Type: "String",
        Description: "The AgentsPoppy account id, for the agentspoppy:account tag.",
      },
      AttributionConnection: {
        Type: "String",
        Description: "The AgentsPoppy connection id, for the agentspoppy:connection tag.",
      },
    },
    Resources: {
      CrewTable: {
        Type: "AWS::DynamoDB::Table",
        Properties: {
          TableName: TABLE_NAME,
          // On-demand: an idle crew bills ~$0 — "unlimited agents" is literal because
          // definitions are rows, essentially free until run (DESIGN.md §3).
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          // CloudFormation enables TTL with a SEPARATE dynamodb:UpdateTimeToLive call
          // after CreateTable (and reads it back with DescribeTimeToLive) — the manifest
          // MUST grant both, or the stack creates the table then rolls back on
          // AccessDenied. Only shows up on a live deploy (the TrafficPoppy lesson);
          // keep these two in lockstep with extension.json.
          TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
          // Deliberately absent: DeletionProtectionEnabled — CloudFormation cannot
          // delete a protected table, which would break leaves-no-trace (AGENTS.md §4).
        },
      },
      WorkspaceBucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          BucketName: { "Fn::Sub": WORKSPACE_BUCKET_SUB },
          // Agent workspaces are private working storage; nothing here is ever public.
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          // No versioning: teardown must be able to empty + delete the bucket without
          // chasing version stacks, and workspace files are agent working state, not
          // records of note. Deliberately no DeletionPolicy: Retain (AGENTS.md §4).
        },
      },
      // Declared in-stack so it's tagged and dies with the stack. If we let Lambda
      // auto-create its log group on first invoke, it would be UNTAGGED — invisible to
      // the host's tag sweep and orphaned forever after teardown (AGENTS.md §4).
      RunnerLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: {
          LogGroupName: `/aws/lambda/${RUNNER_FUNCTION_NAME}`,
          RetentionInDays: 30,
        },
      },
      RunnerRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: RUNNER_ROLE_NAME,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          },
          // The runner's OWN permissions — the trusted side of the recursive-broker
          // model (DESIGN.md §4). Agents never see these credentials; they only emit
          // tool calls that the dispatcher (P2) executes under this role, per-agent
          // scoped. Everything below is pinned to CrewPoppy's own resources.
          Policies: [
            {
              PolicyName: "CrewPoppyRunnerPolicy",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "Logs",
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    // The ARN is CONSTRUCTED, not read back with
                    // Fn::GetAtt [RunnerLogGroup, Arn]. CloudFormation resolves that
                    // attribute by calling `logs:DescribeLogGroups`, which is a
                    // COLLECTION api: it cannot be resource-scoped, so a least-privilege
                    // grant on /aws/lambda/CrewPoppy* is denied and the whole stack rolls
                    // back ("Unable to retrieve Arn attribute for AWS::Logs::LogGroup").
                    // The log group name is a constant we choose, so building the ARN
                    // costs nothing and keeps the permission set tight. The trailing
                    // ":*" is what GetAtt would have returned, and is what lets the
                    // runner write to streams INSIDE the group.
                    Resource: {
                      "Fn::Sub": `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${RUNNER_FUNCTION_NAME}:*`,
                    },
                  },
                  {
                    Sid: "OwnTable",
                    Effect: "Allow",
                    Action: [
                      "dynamodb:GetItem",
                      "dynamodb:PutItem",
                      "dynamodb:UpdateItem",
                      "dynamodb:DeleteItem",
                      "dynamodb:Query",
                    ],
                    Resource: { "Fn::GetAtt": ["CrewTable", "Arn"] },
                  },
                  {
                    Sid: "OwnWorkspace",
                    Effect: "Allow",
                    Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
                    Resource: [
                      { "Fn::GetAtt": ["WorkspaceBucket", "Arn"] },
                      { "Fn::Join": ["", [{ "Fn::GetAtt": ["WorkspaceBucket", "Arn"] }, "/*"]] },
                    ],
                  },
                  {
                    // 🪤 THE MISSING PREREQUISITE (live failure, 2026-07-26):
                    //   "Model access is denied due to IAM user or service role is not
                    //    authorized to perform the required AWS Marketplace actions
                    //    (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)"
                    //
                    // Bedrock auto-subscribes a third-party model on first use, using the
                    // CALLER's permissions. Without these, the subscription attempt fails
                    // silently — and this also explains the earlier mystery where Claude
                    // answered once and then stopped: calls pass PROVISIONALLY during the
                    // ~15-minute settling window, then fail once the subscription can't be
                    // completed. The Anthropic form was one prerequisite; this is the other.
                    //
                    // Needed only for the FIRST use of a model in an account, but it must
                    // be held by whoever makes that call — here, the runner. Deliberately
                    // NOT granting Unsubscribe: nothing we do should ever cancel a
                    // subscription. Marketplace actions take no resource scope (the only
                    // narrowing available is an aws-marketplace:ProductId condition, and
                    // the product ids for the model catalogue aren't knowable at build
                    // time). This lives in the runner's IN-STACK role, so it does not
                    // touch the poppy's manifest or its rating.
                    Sid: "BedrockModelSubscription",
                    Effect: "Allow",
                    Action: ["aws-marketplace:Subscribe", "aws-marketplace:ViewSubscriptions"],
                    Resource: "*",
                  },
                  {
                    // The Bedrock permission (DESIGN.md §6): inference bills to the
                    // owner's AWS, via IAM — no API key exists anywhere. InvokeModel*
                    // covers text inference AND the §3c avatar image models (same
                    // action, different model ids). Model access itself is the owner's
                    // one-time opt-in in the Bedrock console.
                    Sid: "Bedrock",
                    Effect: "Allow",
                    Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                    // Foundation models (account-less ARNs) + the region-routed
                    // inference profiles newer Claude models require. Invocation only —
                    // the runner can never alter Bedrock config.
                    Resource: [
                      "arn:aws:bedrock:*::foundation-model/*",
                      "arn:aws:bedrock:*:*:inference-profile/*",
                    ],
                  },
                  {
                    // The ticker hands each due agent its OWN invocation, so the runner
                    // has to be able to invoke itself (DESIGN §5b). Scoped to exactly one
                    // function — its own — and the ARN is CONSTRUCTED, never read back
                    // with Fn::GetAtt (the §2b trap).
                    //
                    // 🪤 Missing this is silent: the tick finds due agents, writes their
                    // run rows, then fails at the invoke. The runs sit at "running" until
                    // the staleness rule marks them failed, and nothing on screen says
                    // "permission". It cost a live schedule test.
                    Sid: "InvokeSelf",
                    Effect: "Allow",
                    Action: ["lambda:InvokeFunction"],
                    Resource: {
                      "Fn::Sub": `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${RUNNER_FUNCTION_NAME}`,
                    },
                  },
                  {
                    // Email (DESIGN §4c). Sending is scoped to identities the owner has
                    // ALREADY verified in their own account — this grant creates no new
                    // ability to prove an address, only to use one that is proven.
                    //
                    // What stops an agent emailing a stranger is NOT this policy: it's
                    // the dispatcher, which never sends to a non-owner address without
                    // the owner approving that exact message. The policy is the outer
                    // bound; the gate is the control.
                    Sid: "SendMail",
                    Effect: "Allow",
                    // 🪤 BOTH actions (live failure, 2026-07-28): an email WITH an
                    // attachment goes out as raw MIME, and IAM authorises that as
                    // ses:SendRawEmail — a different action from plain SendEmail. With
                    // only the first, plain mail worked and every attachment send was
                    // AccessDenied. Same identity scope for both; no new reach.
                    Action: ["ses:SendEmail", "ses:SendRawEmail"],
                    Resource: "arn:aws:ses:*:*:identity/*",
                  },
                ],
              },
            },
          ],
        },
      },
      RunnerFunction: {
        Type: "AWS::Lambda::Function",
        DependsOn: ["RunnerLogGroup"],
        Properties: {
          FunctionName: RUNNER_FUNCTION_NAME,
          Description: "CrewPoppy agent-runner — loads an agent, calls Bedrock, enforces the spend guardrails.",
          Runtime: "nodejs20.x",
          Architectures: ["arm64"],
          Handler: "agent-runner.handler",
          Role: { "Fn::GetAtt": ["RunnerRole", "Arn"] },
          Code: {
            S3Bucket: { Ref: "LambdaCodeBucket" },
            S3Key: { Ref: "LambdaCodeKey" },
          },
          // P0 defaults, deliberately tiny: nothing invokes this yet. P1 sizes it for
          // the real loop (and the §7 wall-clock cap becomes the enforced timeout).
          Environment: {
            Variables: {
              // Passed in rather than derived: the runner must never have to guess a
              // resource name, and CloudFormation already knows both.
              CREWPOPPY_TABLE: TABLE_NAME,
              CREWPOPPY_WORKSPACE_BUCKET: { "Fn::Sub": WORKSPACE_BUCKET_SUB },
              // Where approval links point. A GetAtt on our own Url resource — CFN has
              // the value from the create response, no describe call involved.
              CREWPOPPY_APPROVAL_URL: { "Fn::GetAtt": ["ApprovalUrl", "FunctionUrl"] },
            },
          },
          MemorySize: 512,
          // The §7 wall-clock cap (default 120s) is enforced INSIDE the loop; this is
          // the outer backstop, generous enough that the guardrail — not Lambda — is
          // what stops a run, so the user always gets a recorded reason.
          Timeout: 300,
        },
      },

      /**
       * The email-approval endpoint (DESIGN §15e) — deliberately its OWN function with a
       * MINIMAL role, because its Function URL is reachable from the public internet.
       * What that role cannot do is the security design: no Bedrock, no SES, no S3 —
       * only the table and invoking the runner. A stranger who finds the URL has found
       * a door with a 64-hex single-use token for a lock and almost nothing behind it.
       */
      ApprovalLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: {
          LogGroupName: `/aws/lambda/${APPROVAL_FUNCTION_NAME}`,
          RetentionInDays: 30,
        },
      },
      ApprovalRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: APPROVAL_ROLE_NAME,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
            ],
          },
          Policies: [
            {
              PolicyName: "CrewPoppyApprovalPolicy",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "Logs",
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    Resource: {
                      "Fn::Sub": `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${APPROVAL_FUNCTION_NAME}:*`,
                    },
                  },
                  {
                    Sid: "Table",
                    Effect: "Allow",
                    Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
                    Resource: {
                      "Fn::Sub": `arn:\${AWS::Partition}:dynamodb:\${AWS::Region}:\${AWS::AccountId}:table/${TABLE_NAME}`,
                    },
                  },
                  {
                    Sid: "ResumeRunner",
                    Effect: "Allow",
                    Action: ["lambda:InvokeFunction"],
                    Resource: {
                      "Fn::Sub": `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${RUNNER_FUNCTION_NAME}`,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      ApprovalFunction: {
        Type: "AWS::Lambda::Function",
        DependsOn: ["ApprovalLogGroup"],
        Properties: {
          FunctionName: APPROVAL_FUNCTION_NAME,
          Description: "CrewPoppy email-approval endpoint — renders a waiting request, applies one answer, once.",
          Runtime: "nodejs20.x",
          Architectures: ["arm64"],
          Handler: "approval.handler",
          Role: { "Fn::GetAtt": ["ApprovalRole", "Arn"] },
          Code: { S3Bucket: { Ref: "LambdaCodeBucket" }, S3Key: { Ref: "LambdaCodeKey" } },
          Environment: {
            Variables: {
              CREWPOPPY_TABLE: TABLE_NAME,
              CREWPOPPY_RUNNER: RUNNER_FUNCTION_NAME,
            },
          },
          MemorySize: 128,
          Timeout: 10,
        },
      },
      ApprovalUrl: {
        Type: "AWS::Lambda::Url",
        Properties: {
          TargetFunctionArn: { "Fn::GetAtt": ["ApprovalFunction", "Arn"] },
          // NONE is deliberate: the owner clicks this from any mail app, with no AWS
          // identity. The auth is the single-use token in the path (§15e).
          AuthType: "NONE",
        },
      },
      // 🪤 BOTH permissions (live failure, 2026-07-28): a public (AuthType NONE) URL
      // now requires lambda:InvokeFunctionUrl AND lambda:InvokeFunction granted to "*" —
      // the console's own warning banner states it. The older documented recipe granted
      // only the first, and every request answered 403 Forbidden.
      //
      // 🪤 And the second grant CANNOT carry the FunctionUrlAuthType condition — AWS
      // rejects it ("only supported for lambda:InvokeFunctionUrl"), which rolled back a
      // live update. It goes in bare. Honest posture note: that lets any AWS-
      // authenticated principal invoke this function directly — which changes nothing
      // real, because the URL already lets ANONYMOUS callers reach the same handler.
      // The function's own minimal role and the single-use token stay the actual walls.
      ApprovalUrlPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: APPROVAL_FUNCTION_NAME,
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
        },
        DependsOn: ["ApprovalFunction"],
      },
      ApprovalInvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: APPROVAL_FUNCTION_NAME,
          Action: "lambda:InvokeFunction",
          Principal: "*",
        },
        DependsOn: ["ApprovalFunction"],
      },

      /**
       * The mobile door (DESIGN §15h M1). The phone talks to the owner's OWN account and
       * nothing else, so the whole door lives in this stack: a Cognito user pool holding
       * exactly ONE user (the owner — nobody can sign themselves up), and a second
       * Function URL Lambda in front of the same table the desktop reads.
       *
       * Deliberately NOT API Gateway: apigateway grants would stress the STS packed-policy
       * budget (the §2b trap) for something a Function URL + in-code JWT verification does
       * with zero new manifest actions beyond cognito-idp.
       */
      MobileUserPool: {
        Type: "AWS::Cognito::UserPool",
        Properties: {
          UserPoolName: MOBILE_USER_POOL_NAME,
          // The whole security posture in one flag: there is no sign-up. The only way a
          // user exists is the desktop's pairing flow creating the owner (AdminCreateUser).
          AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
          Policies: { PasswordPolicy: { MinimumLength: 12 } },
          // No email/SMS anything: recovery is re-pairing from the desktop, which can
          // always reset the password (AdminSetUserPassword). A recovery email would be
          // a second door with a weaker lock.
          AccountRecoverySetting: { RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }] },
          // Tags at birth — Cognito pools are NOT covered by CloudFormation's stack-tag
          // propagation (it skips resources with their own tag property shape), so the
          // attribution tags are stamped here explicitly. Untagged = invisible to the
          // host's sweep = a guaranteed certify failure. Values arrive as parameters
          // because the template is built once, content-addressed, per commit.
          UserPoolTags: {
            "agentspoppy:account": { Ref: "AttributionAccount" },
            "agentspoppy:app": "com.crewpoppy.desktop",
            "agentspoppy:connection": { Ref: "AttributionConnection" },
            "agentspoppy:managed": "crewpoppy",
          },
          // Deliberately absent: DeletionProtection — it would break leaves-no-trace.
        },
      },
      MobileUserPoolClient: {
        Type: "AWS::Cognito::UserPoolClient",
        Properties: {
          ClientName: "CrewPoppyMobileApp",
          UserPoolId: { Ref: "MobileUserPool" },
          // A public mobile client: no secret (it cannot keep one), SRP only — the
          // password never crosses the wire, not even to our own Lambda.
          GenerateSecret: false,
          ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
          // "User does not exist" vs "wrong password" must be the same answer.
          PreventUserExistenceErrors: "ENABLED",
        },
      },
      MobileApiLogGroup: {
        Type: "AWS::Logs::LogGroup",
        Properties: {
          LogGroupName: `/aws/lambda/${MOBILE_API_FUNCTION_NAME}`,
          RetentionInDays: 30,
        },
      },
      /**
       * Same shape as the approval role, same reasoning: this function faces the internet,
       * so its role is a list of what a stranger gets if every other wall fails — the
       * table, and invoking the runner. No Bedrock, no SES, no S3, no Cognito admin.
       * (JWT verification needs no AWS permission at all: the pool's public JWKS keys.)
       */
      MobileApiRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: MOBILE_API_ROLE_NAME,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" },
            ],
          },
          Policies: [
            {
              PolicyName: "CrewPoppyMobileApiPolicy",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "Logs",
                    Effect: "Allow",
                    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    Resource: {
                      "Fn::Sub": `arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/${MOBILE_API_FUNCTION_NAME}:*`,
                    },
                  },
                  {
                    // Unlike the approval role, Query IS here: the phone lists the crew,
                    // run histories and transcripts — but only after a verified Cognito
                    // login, where the approval endpoint answers to anyone with a link.
                    //
                    // DeleteItem is here for exactly ONE thing: clearing a chat from the
                    // phone (founder, 2026-07-31 — a long thread on a small screen needs
                    // tidying where you're reading it). Same narrow semantics as the
                    // desktop's: runs, transcripts and checkpoints only. The agent
                    // definition, its memory, its files and — critically — its SPEND
                    // COUNTERS are not deletable through this door, so tidying a chat can
                    // never reset a cost cap. The handler enforces that; this is the
                    // outer bound.
                    Sid: "Table",
                    Effect: "Allow",
                    Action: [
                      "dynamodb:GetItem",
                      "dynamodb:PutItem",
                      "dynamodb:UpdateItem",
                      "dynamodb:Query",
                      "dynamodb:DeleteItem",
                    ],
                    Resource: {
                      "Fn::Sub": `arn:\${AWS::Partition}:dynamodb:\${AWS::Region}:\${AWS::AccountId}:table/${TABLE_NAME}`,
                    },
                  },
                  {
                    Sid: "StartRunner",
                    Effect: "Allow",
                    Action: ["lambda:InvokeFunction"],
                    Resource: {
                      "Fn::Sub": `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${RUNNER_FUNCTION_NAME}`,
                    },
                  },
                  {
                    // Attaching a file from the phone (founder, 2026-07-31). PutObject
                    // ONLY: this role signs a link for the owner's phone to upload a
                    // document into an agent's workspace. It cannot READ what agents
                    // have written, cannot delete anything, and cannot touch any other
                    // bucket. The signed link itself is minted for ONE key and dies in
                    // five minutes, so the reach is narrower again than this policy.
                    Sid: "AttachToWorkspace",
                    Effect: "Allow",
                    Action: ["s3:PutObject"],
                    Resource: {
                      "Fn::Join": ["", [{ "Fn::GetAtt": ["WorkspaceBucket", "Arn"] }, "/*"]],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      MobileApiFunction: {
        Type: "AWS::Lambda::Function",
        DependsOn: ["MobileApiLogGroup"],
        Properties: {
          FunctionName: MOBILE_API_FUNCTION_NAME,
          Description: "CrewPoppy mobile API — the phone's Cognito-authenticated window onto the crew.",
          Runtime: "nodejs20.x",
          Architectures: ["arm64"],
          Handler: "mobile-api.handler",
          Role: { "Fn::GetAtt": ["MobileApiRole", "Arn"] },
          Code: { S3Bucket: { Ref: "LambdaCodeBucket" }, S3Key: { Ref: "LambdaCodeKey" } },
          Environment: {
            Variables: {
              CREWPOPPY_TABLE: TABLE_NAME,
              CREWPOPPY_RUNNER: RUNNER_FUNCTION_NAME,
              CREWPOPPY_WORKSPACE_BUCKET: { "Fn::Sub": WORKSPACE_BUCKET_SUB },
              // Ref returns both ids from the CREATE response — no describe call, so the
              // collection-API trap (§2b) stays dodged.
              MOBILE_USER_POOL_ID: { Ref: "MobileUserPool" },
              MOBILE_CLIENT_ID: { Ref: "MobileUserPoolClient" },
            },
          },
          MemorySize: 256,
          Timeout: 15,
        },
      },
      MobileApiUrl: {
        Type: "AWS::Lambda::Url",
        Properties: {
          TargetFunctionArn: { "Fn::GetAtt": ["MobileApiFunction", "Arn"] },
          // NONE at the URL layer because the REAL auth happens in code: every request
          // must carry a Cognito access token, verified against the pool's signing keys
          // before the handler reads a single row (mobile-api.ts). Function URLs offer
          // no Cognito authorizer — that's an API Gateway feature we deliberately skip.
          AuthType: "NONE",
        },
      },
      // Both permissions or the URL answers 403 to everyone — the exact live failure the
      // approval endpoint hit on 2026-07-28; see ApprovalUrlPermission above.
      MobileApiUrlPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: MOBILE_API_FUNCTION_NAME,
          Action: "lambda:InvokeFunctionUrl",
          Principal: "*",
          FunctionUrlAuthType: "NONE",
        },
        DependsOn: ["MobileApiFunction"],
      },
      MobileApiInvokePermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: MOBILE_API_FUNCTION_NAME,
          Action: "lambda:InvokeFunction",
          Principal: "*",
        },
        DependsOn: ["MobileApiFunction"],
      },

      /**
       * ONE ticker for the whole install (DESIGN §5b). Not one rule per agent: a schedule
       * is DATA on the agent, and this pokes the runner every few minutes to ask which
       * agents are due.
       *
       * 🪤 Both ARNs below are CONSTRUCTED with Fn::Sub, never read back with Fn::GetAtt.
       * That's the §2b lesson repeating: a GetAtt makes CloudFormation call a describe API
       * on our behalf, and least-privilege grants are exactly where those fail — it cost a
       * whole stack rollback once already.
       */
      TickRule: {
        Type: "AWS::Events::Rule",
        Properties: {
          Name: TICK_RULE_NAME,
          Description: "Wakes the CrewPoppy runner to start any agent whose schedule is due.",
          // 🪤 NOT `rate(5 minutes)`. A rate expression counts from the moment the rule
          // was CREATED, so its ticks land on an arbitrary offset — :02, :07, :12… or
          // :06, :11, :16. In the second case a schedule set for 21:00 is never sampled
          // at all: the ticker simply never looks during its window, and whether an
          // agent runs depends on which minute the stack happened to be deployed.
          //
          // A cron expression is aligned to the clock, so the ticks are always :00, :05,
          // :10… — which is exactly the set of minutes `sanitiseSchedule` snaps to.
          ScheduleExpression: `cron(0/${TICK_MINUTES} * * * ? *)`,
          State: "ENABLED",
          Targets: [
            {
              Id: "runner",
              Arn: {
                "Fn::Sub": `arn:\${AWS::Partition}:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${RUNNER_FUNCTION_NAME}`,
              },
              Input: JSON.stringify({ kind: "tick" }),
            },
          ],
        },
      },

      /** EventBridge may invoke the runner — and ONLY from this one rule. */
      TickPermission: {
        Type: "AWS::Lambda::Permission",
        Properties: {
          FunctionName: RUNNER_FUNCTION_NAME,
          Action: "lambda:InvokeFunction",
          Principal: "events.amazonaws.com",
          // Without SourceArn any EventBridge rule in the account could invoke the runner.
          SourceArn: {
            "Fn::Sub": `arn:\${AWS::Partition}:events:\${AWS::Region}:\${AWS::AccountId}:rule/${TICK_RULE_NAME}`,
          },
        },
        DependsOn: ["RunnerFunction"],
      },
    },
    Outputs: {
      TableName: {
        Description: "The DynamoDB table holding agent definitions, memory and transcripts.",
        Value: { Ref: "CrewTable" },
      },
      WorkspaceBucketName: {
        Description: "The S3 bucket holding per-agent workspaces.",
        Value: { Ref: "WorkspaceBucket" },
      },
      RunnerFunctionName: {
        Description: "The agent-runner Lambda.",
        Value: { Ref: "RunnerFunction" },
      },
      RunnerRoleArn: {
        Description: "Execution role of the agent-runner (the trusted side of the tool broker).",
        Value: { "Fn::GetAtt": ["RunnerRole", "Arn"] },
      },
      // The three values the phone needs, surfaced as outputs so the desktop's pairing QR
      // is a DescribeStacks read (already granted) — never a cognito describe call.
      MobileUserPoolId: {
        Description: "The Cognito user pool holding the one mobile login (the owner).",
        Value: { Ref: "MobileUserPool" },
      },
      MobileClientId: {
        Description: "The mobile app's Cognito client id (public client, SRP only).",
        Value: { Ref: "MobileUserPoolClient" },
      },
      MobileApiUrl: {
        Description: "The mobile API endpoint — every request requires a Cognito token.",
        Value: { "Fn::GetAtt": ["MobileApiUrl", "FunctionUrl"] },
      },
    },
  };
}
