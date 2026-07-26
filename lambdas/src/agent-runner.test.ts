// The runner is where the spend guardrails actually bite, so these drive the real
// handler with AWS faked underneath it — not the pure helpers, which guardrails.test.ts
// already covers.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENTS_PK, PROVEN_SK, agentSk, provenPk, spendPk, spendSk, type AgentDef } from "@crewpoppy/shared";

const state = vi.hoisted(() => ({
  /** Fake table: "pk|sk" -> item */
  items: new Map<string, Record<string, unknown>>(),
  /** Every InvokeModel input, so we can assert the model was (or wasn't) called. */
  invocations: [] as Record<string, unknown>[],
  /** What Bedrock should do next. */
  modelReply: { text: "Here is your answer.", inputTokens: 100, outputTokens: 50 } as
    | { text: string; inputTokens: number; outputTokens: number }
    | Error,
}));

const key = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Cmd {
    constructor(public input: Record<string, any>) {}
  }
  return {
    GetCommand: class extends Cmd {},
    PutCommand: class extends Cmd {},
    UpdateCommand: class extends Cmd {},
    QueryCommand: class extends Cmd {},
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: Cmd) {
          const n = cmd.constructor.name;
          if (n === "GetCommand") {
            return { Item: state.items.get(key(cmd.input.Key.pk, cmd.input.Key.sk)) };
          }
          if (n === "PutCommand") {
            state.items.set(key(cmd.input.Item.pk, cmd.input.Item.sk), cmd.input.Item);
            return {};
          }
          if (n === "UpdateCommand") {
            // Only ADD is used, and only for spend — model it faithfully.
            const k = key(cmd.input.Key.pk, cmd.input.Key.sk);
            const cur = (state.items.get(k) ?? { ...cmd.input.Key, usd: 0 }) as { usd: number };
            cur.usd = Number(cur.usd ?? 0) + Number(cmd.input.ExpressionAttributeValues[":u"]);
            state.items.set(k, cur as never);
            return {};
          }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class InvokeModelCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    InvokeModelCommand,
    BedrockRuntimeClient: class {
      async send(cmd: InvokeModelCommand) {
        state.invocations.push(cmd.input);
        if (state.modelReply instanceof Error) throw state.modelReply;
        const r = state.modelReply;
        return {
          body: new TextEncoder().encode(
            JSON.stringify({
              content: [{ type: "text", text: r.text }],
              usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
            }),
          ),
        };
      }
    },
  };
});

const { handler } = await import("./agent-runner");

const TABLE = "CrewPoppyData";
const agent: AgentDef = {
  id: "a1",
  name: "Emma",
  role: "Research Assistant",
  instructions: "Be concise.",
  modelId: "qwen.qwen3-32b-v1:0", // a model with a measured rate, so cost is computed
  tools: [],
  caps: { maxIterations: 8, maxTokensPerRun: 20_000, maxWallClockMs: 120_000, monthlySpendCapUsd: 10 },
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

const runOf = (agentId = "a1") =>
  [...state.items.values()].find((i) => String(i.sk).startsWith("run#") && i.agentId === agentId) as any;

beforeEach(() => {
  state.items.clear();
  state.invocations = [];
  state.modelReply = { text: "Here is your answer.", inputTokens: 100, outputTokens: 50 };
  state.items.set(key(AGENTS_PK, agentSk("a1")), { pk: AGENTS_PK, sk: agentSk("a1"), ...agent });
});

describe("a normal run", () => {
  it("answers, persists the transcript, and records tokens and cost", async () => {
    const r = await handler({ runId: "r1", agentId: "a1", input: "Summarise this.", tableName: TABLE });
    expect(r.status).toBe("succeeded");

    const run = runOf();
    expect(run.output).toBe("Here is your answer.");
    expect(run.cost.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(run.cost.usd).toBeGreaterThan(0);
    expect(run.stopReason).toBe("completed");

    // Both sides of the conversation are on the record (DESIGN §9: nothing hidden).
    const msgs = [...state.items.values()].filter((i) => String(i.sk).startsWith("msg#"));
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("invokes through the REGIONAL INFERENCE PROFILE, not the bare model id", async () => {
    await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });
    // A bare id fails with "on-demand throughput isn't supported" (DESIGN §2c).
    expect(String(state.invocations[0]!.modelId)).toMatch(/^(eu|us|apac)\./);
  });

  it("tells the model it is an AI and must not claim otherwise (DESIGN §3)", async () => {
    await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });
    const body = JSON.parse(String(state.invocations[0]!.body));
    expect(body.system).toMatch(/never claim to be human/i);
    expect(body.system).toContain("Emma");
  });

  it("records the model as PROVEN, so the list can stop trusting a lagging status field", async () => {
    await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });
    const proven = state.items.get(`${provenPk(agent.modelId)}|${PROVEN_SK}`);
    expect(proven).toBeDefined();
    expect(proven!.modelId).toBe(agent.modelId);
  });

  it("does not mark a model proven when the run failed", async () => {
    state.modelReply = new Error("ThrottlingException");
    await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });
    expect(state.items.get(`${provenPk(agent.modelId)}|${PROVEN_SK}`)).toBeUndefined();
  });

  it("adds the run's cost to the agent's monthly counter", async () => {
    await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });
    const spend = [...state.items.values()].find((i) => String(i.pk) === spendPk("a1")) as any;
    expect(spend.usd).toBeGreaterThan(0);
  });
});

describe("the spend cap is a mechanism (DESIGN §7)", () => {
  it("refuses to start — and never calls the model — once the monthly cap is reached", async () => {
    const month = new Date().toISOString().slice(0, 7);
    state.items.set(key(spendPk("a1"), spendSk(month)), { pk: spendPk("a1"), sk: spendSk(month), usd: 10 });

    const r = await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });

    expect(r.status).toBe("stopped");
    expect(state.invocations).toHaveLength(0); // the point: no tokens were spent
    const run = runOf();
    expect(run.stopReason).toBe("monthly_spend_cap");
    expect(run.message).toContain("$10.00");
  });

  it("stops without calling the model when the agent's iteration cap is zero-ish", async () => {
    state.items.set(key(AGENTS_PK, agentSk("a1")), {
      pk: AGENTS_PK, sk: agentSk("a1"), ...agent, caps: { ...agent.caps, maxIterations: 0 },
    });
    const r = await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });
    expect(r.status).toBe("stopped");
    expect(runOf().stopReason).toBe("max_iterations");
    expect(state.invocations).toHaveLength(0);
  });
});

describe("failures are recorded, never swallowed", () => {
  it("explains the Anthropic form specifically, because that one is actionable", async () => {
    state.modelReply = new Error("Model use case details have not been submitted for this account.");
    const r = await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });

    expect(r.status).toBe("failed");
    const run = runOf();
    expect(run.message).toMatch(/one-time Anthropic form/i);
    expect(run.message).not.toMatch(/use case details have not been submitted/); // not the raw error
  });

  it("explains the first-use Marketplace subscription in terms the user can act on", async () => {
    // Live failure. Alarming-looking, entirely normal, and the actionable signal is an
    // email — not anything about IAM roles, which the raw error talks about.
    state.modelReply = new Error(
      "Model access is denied due to IAM user or service role is not authorized to perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe) to enable access",
    );
    await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });

    const m = String(runOf().message);
    expect(m).toMatch(/email/i); // the thing to wait for
    expect(m).toMatch(/free/i); // nobody should fear a surprise charge
    expect(m).toMatch(/run this again/i); // and what to do after
    expect(m).not.toMatch(/IAM|aws-marketplace:/); // never the raw jargon
  });

  it("records any other failure with a calm, truncated message", async () => {
    state.modelReply = new Error("ThrottlingException: too many requests");
    const r = await handler({ runId: "r1", agentId: "a1", input: "Hi", tableName: TABLE });
    expect(r.status).toBe("failed");
    expect(runOf().stopReason).toBe("error");
    expect(runOf().message).toMatch(/couldn't finish/i);
  });

  it("fails cleanly when the agent was deleted between starting and running", async () => {
    state.items.clear();
    const r = await handler({ runId: "r1", agentId: "gone", input: "Hi", tableName: TABLE });
    expect(r.status).toBe("failed");
    expect(runOf("gone").message).toMatch(/no longer exists/i);
  });
});
