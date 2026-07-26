import { describe, expect, it, vi } from "vitest";
import { GetFoundationModelAvailabilityCommand, type BedrockClient } from "@aws-sdk/client-bedrock";
import { consoleUrl, getModelAccess } from "./bedrock";
import { DEFAULT_MODEL_ID } from "@crewpoppy/shared";

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
