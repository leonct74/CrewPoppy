import { describe, expect, it } from "vitest";
import { TICK_MINUTES } from "@crewpoppy/shared";
import {
  buildTemplate,
  RUNNER_FUNCTION_NAME,
  RUNNER_ROLE_NAME,
  STACK_NAME,
  TABLE_NAME,
  TTL_ATTRIBUTE,
} from "./template";

describe("buildTemplate", () => {
  const template = buildTemplate();
  const resources = template.Resources as Record<string, { Type: string; Properties: any; DeletionPolicy?: string }>;

  it("is pure — identical bytes on every call (content-addressing depends on it)", () => {
    expect(JSON.stringify(buildTemplate())).toEqual(JSON.stringify(buildTemplate()));
  });

  it("names match the manifest's CrewPoppy* scopes", () => {
    expect(STACK_NAME).toBe("CrewPoppyStack");
    expect(TABLE_NAME).toMatch(/^CrewPoppy/);
    expect(RUNNER_FUNCTION_NAME).toMatch(/^CrewPoppy/);
    expect(RUNNER_ROLE_NAME).toMatch(/^CrewPoppy/);
    expect(resources.WorkspaceBucket!.Properties.BucketName["Fn::Sub"]).toMatch(/^crewpoppy-/);
  });

  it("declares the whole footprint, and nothing else", () => {
    // An exact list on purpose: a resource that appears here without a deliberate change
    // to this test is a resource nobody decided to create.
    expect(Object.keys(resources).sort()).toEqual([
      "CrewTable",
      "RunnerFunction",
      "RunnerLogGroup",
      "RunnerRole",
      "TickPermission",
      "TickRule",
      "WorkspaceBucket",
    ]);
  });

  describe("the schedule ticker (DESIGN §5b)", () => {
    it("is ONE rule for the whole install, not one per agent", () => {
      const rule = resources.TickRule!.Properties as { ScheduleExpression: string; Targets: unknown[] };
      expect(rule.ScheduleExpression).toBe(`rate(${TICK_MINUTES} minutes)`);
      expect(rule.Targets).toHaveLength(1);
    });

    it("builds both ARNs with Fn::Sub — never Fn::GetAtt (the collection-API trap)", () => {
      // Same lesson as the log group: a GetAtt makes CloudFormation call a describe API
      // under our least-privilege grants, and that is what rolled a whole stack back.
      const json = JSON.stringify([resources.TickRule, resources.TickPermission]);
      expect(json).not.toMatch(/GetAtt/);
      expect(json).toMatch(/Fn::Sub/);
    });

    it("lets ONLY that rule invoke the runner", () => {
      const p = resources.TickPermission!.Properties as {
        Principal: string;
        Action: string;
        SourceArn: unknown;
      };
      expect(p.Principal).toBe("events.amazonaws.com");
      expect(p.Action).toBe("lambda:InvokeFunction");
      // Without SourceArn, any EventBridge rule in the account could fire the runner.
      expect(JSON.stringify(p.SourceArn)).toMatch(/rule\/CrewPoppyTick/);
    });
  });

  it("enables TTL from day zero (checkpoint/question expiry, DESIGN §5)", () => {
    expect(resources.CrewTable!.Properties.TimeToLiveSpecification).toEqual({
      AttributeName: TTL_ATTRIBUTE,
      Enabled: true,
    });
  });

  it("leaves no trace: nothing retained, nothing protected, nothing versioned", () => {
    for (const [name, resource] of Object.entries(resources)) {
      expect(resource.DeletionPolicy, `${name} must not be retained`).toBeUndefined();
    }
    expect(resources.CrewTable!.Properties.DeletionProtectionEnabled).toBeUndefined();
    expect(resources.WorkspaceBucket!.Properties.VersioningConfiguration).toBeUndefined();
  });

  it("logs to an in-stack, taggable log group — never a Lambda-auto-created orphan", () => {
    expect(resources.RunnerLogGroup!.Properties.LogGroupName).toBe(`/aws/lambda/${RUNNER_FUNCTION_NAME}`);
    expect(resources.RunnerFunction!.Properties.FunctionName).toBe(RUNNER_FUNCTION_NAME);
  });

  it("keeps the workspace bucket private", () => {
    expect(resources.WorkspaceBucket!.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it("gives the runner Bedrock invocation only, scoped to model ARNs (DESIGN §6)", () => {
    const statements = resources.RunnerRole!.Properties.Policies[0].PolicyDocument.Statement as Array<{
      Sid: string;
      Action: string[];
      Resource: unknown;
    }>;
    const bedrock = statements.find((s) => s.Sid === "Bedrock")!;
    expect(bedrock.Action).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
    expect(bedrock.Resource).toEqual([
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:*:inference-profile/*",
    ]);
    // The recursive-broker invariant (DESIGN §4): no statement grants beyond the
    // runner's own table/bucket/logs/model-invocation — in particular, no iam, no sts,
    // and nothing that could mint or broaden credentials.
    const actions = statements.flatMap((s) => s.Action);
    // aws-marketplace is the one non-CrewPoppy service, and only to let Bedrock finish
    // its own first-use subscription — never to reach account resources.
    expect(actions.every((a) => /^(logs|dynamodb|s3|bedrock|aws-marketplace|ses):/.test(a))).toBe(true);
    expect(actions.some((a) => /^(iam|sts):/.test(a))).toBe(false);
  });

  it("can send mail, but can never verify a new sender (DESIGN §4c)", () => {
    const statements = resources.RunnerRole!.Properties.Policies[0].PolicyDocument.Statement as Array<{
      Sid: string;
      Action: string[];
      Resource: unknown;
    }>;
    const mail = statements.find((s) => s.Sid === "SendMail")!;
    // Sending only, and only from identities the owner already proved they own. Anything
    // that could CREATE an identity would let an agent's mail come from an address the
    // owner never authorised — a different product with a different risk.
    expect(mail.Action).toEqual(["ses:SendEmail"]);
    expect(mail.Resource).toBe("arn:aws:ses:*:*:identity/*");
    const ses = statements.flatMap((s) => s.Action).filter((a) => a.startsWith("ses:"));
    expect(ses).toEqual(["ses:SendEmail"]);
  });

  it("never reads back a log-group ARN with Fn::GetAtt (the collection-API trap)", () => {
    // Live-deploy regression (2026-07-26): Fn::GetAtt [RunnerLogGroup, Arn] makes
    // CloudFormation call logs:DescribeLogGroups, which cannot be resource-scoped —
    // our least-privilege grant denied it and the whole stack rolled back. The ARN must
    // stay constructed from the constant name. Any GetAtt against the log group brings
    // the failure straight back.
    const json = JSON.stringify(template);
    expect(json).not.toContain('"Fn::GetAtt":["RunnerLogGroup"');
    expect(json).not.toMatch(/GetAtt[^}]*RunnerLogGroup/);

    const logs = (resources.RunnerRole!.Properties.Policies[0].PolicyDocument.Statement as Array<{
      Sid: string;
      Resource: unknown;
    }>).find((s) => s.Sid === "Logs")!;
    // Constructed, and ending in :* so the runner can write streams inside the group.
    expect(logs.Resource).toEqual({
      "Fn::Sub":
        "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/CrewPoppyRunner:*",
    });
  });

  it("can complete Bedrock's first-use Marketplace subscription, but never cancel one", () => {
    // Without Subscribe/ViewSubscriptions, Bedrock's auto-enablement fails and model
    // calls start returning AccessDenied after the provisional window (live failure).
    const statements = resources.RunnerRole!.Properties.Policies[0].PolicyDocument.Statement as Array<{
      Sid: string;
      Action: string[];
    }>;
    const mk = statements.find((s) => s.Sid === "BedrockModelSubscription")!;
    expect(mk.Action).toContain("aws-marketplace:Subscribe");
    expect(mk.Action).toContain("aws-marketplace:ViewSubscriptions");
    // Cancelling a subscription is never something CrewPoppy should be able to do.
    expect(mk.Action).not.toContain("aws-marketplace:Unsubscribe");
  });

  it("receives Lambda code via content-addressed parameters, never inline", () => {
    expect(Object.keys(template.Parameters)).toEqual(["LambdaCodeBucket", "LambdaCodeKey"]);
    expect(resources.RunnerFunction!.Properties.Code).toEqual({
      S3Bucket: { Ref: "LambdaCodeBucket" },
      S3Key: { Ref: "LambdaCodeKey" },
    });
  });
});
