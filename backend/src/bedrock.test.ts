import { describe, expect, it, vi } from "vitest";
import { GetFoundationModelAvailabilityCommand, type BedrockClient } from "@aws-sdk/client-bedrock";
import { consoleUrl, getModelAccess } from "./bedrock";
import { DEFAULT_MODEL_ID, inferenceProfileFor } from "./models";

function fakeBedrock(reply: unknown | Error) {
  const sent: unknown[] = [];
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      sent.push(cmd);
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  } as unknown as BedrockClient;
  return { client, sent };
}

describe("getModelAccess", () => {
  it("is ready only when the agreement is actually AVAILABLE", async () => {
    const { client } = fakeBedrock({
      agreementAvailability: { status: "AVAILABLE" },
      authorizationStatus: "AUTHORIZED",
      entitlementAvailability: "AVAILABLE",
    });
    const a = await getModelAccess(client);
    expect(a.ready).toBe(true);
    expect(a.message).toBeUndefined();
  });

  it("explains the one-time form when the agreement is missing", async () => {
    // The real state of a fresh account: authorized and entitled, but no agreement,
    // because Anthropic's use-case form hasn't been submitted (DESIGN §2c).
    const { client } = fakeBedrock({
      agreementAvailability: { status: "NOT_AVAILABLE" },
      authorizationStatus: "AUTHORIZED",
      entitlementAvailability: "AVAILABLE",
    });
    const a = await getModelAccess(client);
    expect(a.ready).toBe(false);
    expect(a.message).toMatch(/free/i);
    expect(a.message).toMatch(/once/i);
    expect(a.message).not.toMatch(/NOT_AVAILABLE/); // no raw AWS status at the user
    expect(a.agreement).toBe("NOT_AVAILABLE"); // …but kept for the details view
  });

  it("asks about the BARE foundation-model id, which is what this API accepts", async () => {
    const { client, sent } = fakeBedrock({ agreementAvailability: { status: "AVAILABLE" } });
    await getModelAccess(client);
    const cmd = sent[0] as GetFoundationModelAvailabilityCommand;
    expect(cmd.input.modelId).toBe(DEFAULT_MODEL_ID);
    expect(cmd.input.modelId).not.toMatch(/^(eu|us|apac)\./); // a profile id is rejected here
  });

  it("degrades honestly when the check itself fails, rather than claiming access is fine", async () => {
    const { client } = fakeBedrock(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    const a = await getModelAccess(client);
    expect(a.ready).toBe(false);
    expect(a.unknown).toBe(true);
    expect(a.message).toMatch(/couldn't check/i);
  });
});

describe("inference profile ids (the trap that cost a live test — DESIGN §2c)", () => {
  it("prefixes the region family, because bare ids can't be invoked on demand", () => {
    expect(inferenceProfileFor(DEFAULT_MODEL_ID, "eu-west-1")).toBe(`eu.${DEFAULT_MODEL_ID}`);
    expect(inferenceProfileFor(DEFAULT_MODEL_ID, "us-east-1")).toBe(`us.${DEFAULT_MODEL_ID}`);
    expect(inferenceProfileFor(DEFAULT_MODEL_ID, "ap-southeast-2")).toBe(`apac.${DEFAULT_MODEL_ID}`);
  });

  it("leaves an unknown region alone rather than inventing a prefix", () => {
    expect(inferenceProfileFor(DEFAULT_MODEL_ID, "ca-central-1")).toBe(DEFAULT_MODEL_ID);
  });
});

describe("consoleUrl", () => {
  it("points at the stable service root for the user's region, not a rot-prone deep link", () => {
    const url = consoleUrl("eu-west-1");
    expect(url).toContain("console.aws.amazon.com/bedrock");
    expect(url).toContain("region=eu-west-1");
    expect(url).not.toContain("#/"); // the console was redesigned 2026-06; sub-pages move
  });
});
