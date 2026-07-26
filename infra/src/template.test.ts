import { describe, expect, it } from "vitest";
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

  it("declares the P0 footprint: table, workspace bucket, log group, role, runner", () => {
    expect(Object.keys(resources).sort()).toEqual([
      "CrewTable",
      "RunnerFunction",
      "RunnerLogGroup",
      "RunnerRole",
      "WorkspaceBucket",
    ]);
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
    expect(actions.every((a) => /^(logs|dynamodb|s3|bedrock):/.test(a))).toBe(true);
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

  it("receives Lambda code via content-addressed parameters, never inline", () => {
    expect(Object.keys(template.Parameters)).toEqual(["LambdaCodeBucket", "LambdaCodeKey"]);
    expect(resources.RunnerFunction!.Properties.Code).toEqual({
      S3Bucket: { Ref: "LambdaCodeBucket" },
      S3Key: { Ref: "LambdaCodeKey" },
    });
  });
});
