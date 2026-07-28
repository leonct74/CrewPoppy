// The runner is where the spend guardrails actually bite, so these drive the real
// handler with AWS faked underneath it — not the pure helpers, which guardrails.test.ts
// already covers.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENTS_PK, PROVEN_SK, agentPk, agentSk, provenPk, spendPk, spendSk, type AgentDef,
} from "@crewpoppy/shared";

const state = vi.hoisted(() => ({
  /** Fake table: "pk|sk" -> item */
  items: new Map<string, Record<string, unknown>>(),
  /** Every InvokeModel input, so we can assert the model was (or wasn't) called. */
  invocations: [] as Record<string, unknown>[],
  /** Every self-invocation the ticker fired. */
  lambdaInvokes: [] as Record<string, unknown>[],
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
          if (n === "QueryCommand") {
            const vals = cmd.input.ExpressionAttributeValues as Record<string, string>;
            const pk = vals[":pk"];
            const skPrefix = vals[":sk"];
            const Items = [...state.items.values()].filter(
              (i) => i.pk === pk && (!skPrefix || String(i.sk).startsWith(skPrefix)),
            );
            return { Items };
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

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    InvokeCommand,
    LambdaClient: class {
      async send(cmd: InvokeCommand) {
        state.lambdaInvokes.push(cmd.input);
        return {};
      }
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

const { handler, settlePending } = await import("./agent-runner");

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
  state.lambdaInvokes = [];
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

// ---------------------------------------------------------------------------
// What happens to a message the owner was shown (DESIGN §4c). The UI promises "approving
// sends exactly what you read" — these are the tests that make that true.

describe("settling a message that was waiting for approval", () => {
  const pending = {
    kind: "send_email" as const,
    to: "jane@customer.test",
    subject: "Your enquiry",
    body: "Hello Jane, thanks for getting in touch.",
  };
  const event = (extra: Record<string, unknown>) =>
    ({ runId: "r1", agentId: "a1", input: "x", tableName: "T", ...extra }) as never;

  function ctxWith(sent: Record<string, any>[], fail?: boolean) {
    return {
      ddb: { send: async () => ({}) },
      ses: {
        send: async (c: { input: Record<string, unknown> }) => {
          if (fail) throw new Error("MessageRejected");
          sent.push(c.input);
          return {};
        },
      },
      table: "T",
      agentId: "a1",
      agentName: "Emma",
      enabled: ["send_email"],
      ownerEmail: "marco@example.com",
      maxEmailsPerDay: 50,
      now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    } as never;
  }

  it("sends the STORED message when the owner approved it", async () => {
    const sent: Record<string, any>[] = [];
    const log: string[] = [];
    const text = await settlePending(
      event({ answer: "Yes", approved: true }),
      pending,
      ctxWith(sent),
      async (_r, t) => void log.push(t),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.Destination.ToAddresses).toEqual(["jane@customer.test"]);
    expect(sent[0]!.Content.Simple.Body.Text.Data).toBe(pending.body);
    expect(text).toMatch(/has been sent to jane@customer.test/i);
    expect(text).toMatch(/do not send it again/i);
    expect(log[0]).toMatch(/^Sent to jane@customer.test/);
  });

  it("sends NOTHING when the owner typed changes instead of approving", async () => {
    const sent: Record<string, any>[] = [];
    const log: string[] = [];
    const text = await settlePending(
      event({ answer: "Yes, but change the greeting to 'Hi Sam'." }),
      pending,
      ctxWith(sent),
      async (_r, t) => void log.push(t),
    );
    expect(sent).toHaveLength(0);
    expect(text).toMatch(/did NOT approve/);
    // Their words still reach the agent, so it can revise and propose again.
    expect(text).toMatch(/Hi Sam/);
    expect(log[0]).toMatch(/not sent/i);
  });

  it("tells the agent plainly when an approved send failed at AWS", async () => {
    const text = await settlePending(
      event({ answer: "Yes", approved: true }),
      pending,
      ctxWith([], true),
      async () => {},
    );
    expect(text).toMatch(/sending it failed/i);
    expect(text).toMatch(/do not try again/i);
  });

  it("passes an ordinary answer straight through when nothing was pending", async () => {
    const text = await settlePending(
      event({ answer: "Use the shorter one." }),
      undefined,
      ctxWith([]),
      async () => {},
    );
    expect(text).toBe("Use the shorter one.");
  });
});


// ---------------------------------------------------------------------------
// The ticker (DESIGN §5b). It had no tests, which is exactly how one stuck row blocked
// every schedule for a day while the heartbeat said "1 due".

describe("the ticker", () => {
  // A schedule that is ALWAYS due at the moment the test runs: hourly, minute snapped to
  // the tick slot we are currently inside. The tick reads the real clock, so the test
  // meets it where it is rather than pretending to control it.
  const dueNow = () => ({
    kind: "hourly" as const,
    hour: 9,
    minute: Math.floor(new Date().getMinutes() / 5) * 5,
    weekday: 1,
    timezone: "UTC",
    task: "Email me the overnight summary.",
    enabled: true,
  });

  const seedScheduled = (over: Record<string, unknown> = {}) => {
    state.items.set(key(AGENTS_PK, agentSk("s1")), {
      pk: AGENTS_PK,
      sk: agentSk("s1"),
      ...agent,
      id: "s1",
      schedule: dueNow(),
      ...over,
    });
  };
  const scheduledRuns = () =>
    [...state.items.values()].filter(
      (i) => i.agentId === "s1" && String(i.sk).startsWith("run#sched-"),
    );

  beforeEach(() => {
    process.env.CREWPOPPY_TABLE = TABLE;
  });

  it("starts a due agent with the SLOT id and hands it its own invocation", async () => {
    seedScheduled();
    const r = await handler({ kind: "tick" } as never);
    expect(r.ok).toBe(true);
    const runs = scheduledRuns();
    expect(runs).toHaveLength(1);
    expect(String(runs[0]!.runId)).toMatch(/^sched-s1-/); // the idempotency key
    expect(runs[0]!.input).toBe("Email me the overnight summary.");
    expect(state.lambdaInvokes).toHaveLength(1);
  });

  it("skips an agent whose run is genuinely still working", async () => {
    seedScheduled();
    state.items.set(key(agentPk("s1"), "run#live"), {
      pk: agentPk("s1"), sk: "run#live", runId: "live", agentId: "s1",
      status: "running", startedAt: new Date(Date.now() - 10_000).toISOString(),
    });
    await handler({ kind: "tick" } as never);
    expect(scheduledRuns()).toHaveLength(0); // the no-stacking rule
  });

  it("skips an agent waiting on the owner — an unanswered question is not a green light", async () => {
    seedScheduled();
    state.items.set(key(agentPk("s1"), "run#wait"), {
      pk: agentPk("s1"), sk: "run#wait", runId: "wait", agentId: "s1",
      status: "waiting", startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await handler({ kind: "tick" } as never);
    expect(scheduledRuns()).toHaveLength(0);
  });

  // THE LIVE BUG (2026-07-28). A tick wrote a run row and then failed at the invoke
  // (missing InvokeSelf), leaving it at "running" forever — and every later tick read
  // that status raw and skipped the agent as busy. Due every slot, started never.
  it("is NOT blocked by a run that never reported back", async () => {
    seedScheduled();
    state.items.set(key(agentPk("s1"), "run#stuck"), {
      pk: agentPk("s1"), sk: "run#stuck", runId: "stuck", agentId: "s1",
      status: "running", startedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1h silent
    });
    await handler({ kind: "tick" } as never);
    expect(scheduledRuns()).toHaveLength(1); // the corpse no longer blocks
  });

  it("writes the heartbeat BEFORE starting anyone, so a crashing tick still leaves proof it woke", async () => {
    seedScheduled();
    await handler({ kind: "tick" } as never);
    const beat = state.items.get(key("config", "last-tick")) as Record<string, unknown>;
    expect(beat).toBeTruthy();
    expect(beat.scheduled).toBe(1);
    expect(beat.due).toBe(1);
  });

  it("does nothing at all on a quiet tick — an idle crew stays $0", async () => {
    seedScheduled({ schedule: { ...dueNow(), enabled: false } });
    const r = await handler({ kind: "tick" } as never);
    expect(r.status).toMatch(/0 started/);
    expect(scheduledRuns()).toHaveLength(0);
    expect(state.invocations).toHaveLength(0); // no model call, no tokens, no cost
  });
});

// The attachment completes the founder's core use case (2026-07-28): the approved offer
// PDF actually rides on the approved email.
describe("an approved send with an attachment", () => {
  it("fetches the file from the agent's own prefix and sends raw MIME", async () => {
    const sent: Record<string, any>[] = [];
    const s3Keys: string[] = [];
    const ctx = {
      ddb: { send: async () => ({}) },
      s3: {
        send: async (c: { input: { Key: string } }) => {
          s3Keys.push(c.input.Key);
          return { Body: { transformToByteArray: async () => new TextEncoder().encode("%PDF-1.4 x") } };
        },
      },
      ses: { send: async (c: { input: Record<string, any> }) => { sent.push(c.input); return {}; } },
      table: "T", bucket: "b", agentId: "a1", agentName: "Postie",
      enabled: ["send_email"], ownerEmail: "marco@example.com", maxEmailsPerDay: 50,
      now: () => Date.parse("2026-07-28T10:00:00.000Z"),
    } as never;

    const text = await settlePending(
      { runId: "r1", agentId: "a1", input: "x", tableName: "T", answer: "Yes", approved: true } as never,
      { kind: "send_email", to: "jane@customer.test", subject: "Offer", body: "Attached.", attach: "offer-acme.pdf" },
      ctx,
      async () => {},
    );
    expect(s3Keys).toEqual(["agents/a1/offer-acme.pdf"]);
    expect(sent[0]!.Content.Raw).toBeTruthy();
    expect(Buffer.from(sent[0]!.Content.Raw.Data).toString("utf8")).toContain('filename="offer-acme.pdf"');
    expect(text).toMatch(/has been sent to jane@customer.test/i);
  });

  it("fails gracefully when the file vanished between approval and send", async () => {
    const ctx = {
      ddb: { send: async () => ({}) },
      s3: { send: async () => { throw Object.assign(new Error("gone"), { name: "NoSuchKey" }); } },
      ses: { send: async () => ({}) },
      table: "T", bucket: "b", agentId: "a1", agentName: "Postie",
      enabled: ["send_email"], ownerEmail: "marco@example.com", maxEmailsPerDay: 50,
      now: () => Date.parse("2026-07-28T10:00:00.000Z"),
    } as never;
    const log: string[] = [];
    const text = await settlePending(
      { runId: "r1", agentId: "a1", input: "x", tableName: "T", answer: "Yes", approved: true } as never,
      { kind: "send_email", to: "jane@customer.test", subject: "Offer", body: "b", attach: "gone.pdf" },
      ctx,
      async (_r, t) => void log.push(t),
    );
    expect(text).toMatch(/sending it failed/i);
    expect(log[0]).toMatch(/not sent/i);
  });
});
