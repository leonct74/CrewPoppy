// The runner is where the spend guardrails actually bite, so these drive the real
// handler with AWS faked underneath it — not the pure helpers, which guardrails.test.ts
// already covers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    DeleteCommand: class extends Cmd {},
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: Cmd) {
          const n = cmd.constructor.name;
          if (n === "DeleteCommand") {
            state.items.delete(key(cmd.input.Key.pk, cmd.input.Key.sk));
            return {};
          }
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
            let Items = [...state.items.values()]
              .filter((i) => i.pk === pk && (!skPrefix || String(i.sk).startsWith(skPrefix)))
              // DynamoDB returns a partition sorted by sort key; recall depends on it.
              .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
            if (cmd.input.ScanIndexForward === false) Items = Items.reverse();
            if (cmd.input.Limit) Items = Items.slice(0, cmd.input.Limit);
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

const { handler, settlePending, recentExchanges, pushPing, RECALL_EXCHANGES, RECALL_CHARS } = await import(
  "./agent-runner"
);

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

// The mail intake (docs/mailpoppy-bridge-spec.md) — the receiving side of the trust
// boundary. Every gate is tested as a gate: what it lets through matters less than what
// it refuses.
describe("mail arriving for an agent-owned mailbox", () => {
  const mail = (over: Record<string, unknown> = {}) => ({
    kind: "mail" as const,
    to: "postie@ollydigital.com",
    from: "marco@example.com",
    subject: "Offer for XYZ",
    text: "Please make an offer for XYZ: 2 days consulting.",
    messageId: "ses-msg-001",
    verdicts: { spf: "PASS", dkim: "PASS", spam: "PASS", virus: "PASS" },
    ...over,
  });

  const seedMailWorld = () => {
    process.env.CREWPOPPY_TABLE = TABLE;
    state.items.set(key("config", "owner-email"), { pk: "config", sk: "owner-email", email: "marco@example.com" });
    state.items.set(key(AGENTS_PK, agentSk("m1")), {
      pk: AGENTS_PK, sk: agentSk("m1"), ...agent, id: "m1", name: "Postie",
      emailFrom: "postie@ollydigital.com",
    });
  };
  const mailRuns = () =>
    [...state.items.values()].filter((i) => i.agentId === "m1" && String(i.sk).startsWith("run#mail-"));

  it("starts ONE run for the owner's email, idempotently across redelivery", async () => {
    seedMailWorld();
    const r1 = await handler(mail() as never);
    expect(r1.status).toBe("mail: started");
    const r2 = await handler(mail() as never); // SES redelivers the same messageId
    expect(r2.status).toBe("mail: already handled");
    expect(mailRuns()).toHaveLength(1);
    expect(state.lambdaInvokes).toHaveLength(1);
    expect(String(mailRuns()[0]!.input)).toContain("Offer for XYZ");
  });

  it("drops a forged sender — anyone can type a From line", async () => {
    seedMailWorld();
    const r = await handler(mail({ from: "attacker@evil.test" }) as never);
    expect(r.status).toBe("mail: dropped (sender)");
    expect(mailRuns()).toHaveLength(0);
    expect(state.lambdaInvokes).toHaveLength(0);
  });

  it("drops the owner's OWN address when the verdicts don't prove it", async () => {
    // The whole point of checking verdicts: a spoof of the owner passes the From
    // comparison and must still die here.
    seedMailWorld();
    for (const verdicts of [
      { spf: "FAIL", dkim: "PASS", spam: "PASS" },
      { spf: "PASS", dkim: "FAIL", spam: "PASS" },
      { spf: "PASS", dkim: "PASS", spam: "FAIL" },
      { spf: "PASS", dkim: "PASS", spam: "PASS", virus: "FAIL" },
      undefined, // no verdicts at all is a drop, never a benefit of the doubt
    ]) {
      const r = await handler(mail({ verdicts, messageId: `m-${JSON.stringify(verdicts)}` }) as never);
      expect(r.status).toBe("mail: dropped (verdicts)");
    }
    expect(mailRuns()).toHaveLength(0);
  });

  it("drops mail for an address no agent owns", async () => {
    seedMailWorld();
    const r = await handler(mail({ to: "nobody@ollydigital.com" }) as never);
    expect(r.status).toBe("mail: dropped (no agent)");
    expect(mailRuns()).toHaveLength(0);
  });

  it("skips, not queues, while the agent is busy — the email still sits in the mailbox", async () => {
    seedMailWorld();
    state.items.set(key(agentPk("m1"), "run#live"), {
      pk: agentPk("m1"), sk: "run#live", runId: "live", agentId: "m1",
      status: "running", startedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const r = await handler(mail() as never);
    expect(r.status).toBe("mail: skipped (busy)");
    expect(mailRuns()).toHaveLength(0);
  });

  it("does nothing at all when no owner address is configured", async () => {
    process.env.CREWPOPPY_TABLE = TABLE;
    state.items.set(key(AGENTS_PK, agentSk("m1")), {
      pk: AGENTS_PK, sk: agentSk("m1"), ...agent, id: "m1", emailFrom: "postie@ollydigital.com",
    });
    const r = await handler(mail() as never);
    expect(r.status).toBe("mail: dropped (no approver)");
    expect(mailRuns()).toHaveLength(0);
  });

  // §15i: for a phone-approval agent, the push opt-in row the phone wrote IS a
  // reachable approver — mail may start runs with no owner address at all, because
  // every gated reply can still be approved on the phone.
  describe("a phone-approval agent with no owner address", () => {
    const seedPhoneWorld = (pushEnabled: boolean) => {
      process.env.CREWPOPPY_TABLE = TABLE;
      state.items.set(key(AGENTS_PK, agentSk("m1")), {
        pk: AGENTS_PK, sk: agentSk("m1"), ...agent, id: "m1", name: "Postie",
        emailFrom: "postie@ollydigital.com", openInbox: true, approvalChannel: "phone",
      });
      if (pushEnabled) {
        state.items.set(key("config", "push"), {
          pk: "config", sk: "push", enabled: true, poolId: "eu-west-1_x", relayUrl: "https://agentspoppy.com/",
        });
      }
    };

    it("accepts mail when the phone is notifying — that IS the approver", async () => {
      seedPhoneWorld(true);
      const r = await handler(mail({ from: "customer@buyer.example" }) as never);
      expect(r.status).toBe("mail: started");
      expect(mailRuns()).toHaveLength(1);
    });

    it("still drops everything when push is off — no approver anywhere", async () => {
      seedPhoneWorld(false);
      const r = await handler(mail({ from: "customer@buyer.example" }) as never);
      expect(r.status).toBe("mail: dropped (no approver)");
      expect(mailRuns()).toHaveLength(0);
    });

    it("with no owner address, NOBODY is the owner — a closed inbox accepts nothing", async () => {
      seedPhoneWorld(true);
      const closed = state.items.get(key(AGENTS_PK, agentSk("m1")))!;
      delete (closed as { openInbox?: boolean }).openInbox;
      const r = await handler(mail() as never); // even the founder's own address
      expect(r.status).toBe("mail: dropped (sender)");
      expect(mailRuns()).toHaveLength(0);
    });
  });

  // The open inbox (DESIGN §15g): a per-agent choice that widens who may START a run,
  // and provably nothing else.
  describe("when the agent's inbox is open to anyone", () => {
    const openWorld = () => {
      seedMailWorld();
      state.items.set(key(AGENTS_PK, agentSk("m1")), {
        ...state.items.get(key(AGENTS_PK, agentSk("m1")))!,
        openInbox: true,
      });
    };

    it("starts a run for a customer's email, framed as an OUTSIDE request", async () => {
      openWorld();
      const r = await handler(mail({ from: "customer@buyer.example" }) as never);
      expect(r.status).toBe("mail: started");
      const input = String(mailRuns()[0]!.input);
      expect(input).toContain("customer@buyer.example");
      expect(input).toContain("outside sender");
      expect(input).not.toContain("Email from you");
    });

    it("still frames the owner's own mail as the owner's", async () => {
      openWorld();
      const r = await handler(mail() as never);
      expect(r.status).toBe("mail: started");
      expect(String(mailRuns()[0]!.input)).toContain("Email from you");
    });

    it("still drops a customer whose mail fails the verdicts — open is not gullible", async () => {
      openWorld();
      const r = await handler(
        mail({ from: "customer@buyer.example", verdicts: { spf: "PASS", dkim: "PASS", spam: "FAIL" } }) as never,
      );
      expect(r.status).toBe("mail: dropped (verdicts)");
      expect(mailRuns()).toHaveLength(0);
    });

    it("stays owner-only for every OTHER agent — the flag is per agent, never global", async () => {
      openWorld();
      state.items.set(key(AGENTS_PK, agentSk("m2")), {
        pk: AGENTS_PK, sk: agentSk("m2"), ...agent, id: "m2", name: "Closed",
        emailFrom: "closed@ollydigital.com",
      });
      const r = await handler(
        mail({ to: "closed@ollydigital.com", from: "customer@buyer.example" }) as never,
      );
      expect(r.status).toBe("mail: dropped (sender)");
    });
  });
});

// The assignable-mailbox registry (founder, 2026-07-29): MailPoppy reports toggles over
// the bridge; the editor's SELECT reads what lands here.
describe("mailbox registry events", () => {
  beforeEach(() => {
    process.env.CREWPOPPY_TABLE = TABLE;
  });

  it("registers on assign and releases on unassign, normalised", async () => {
    const on = await handler({ kind: "mailbox", email: "  Postie@AgentsPoppy.com ", agentOwned: true } as never);
    expect(on.status).toBe("mailbox: registered");
    expect(state.items.get(key("config", "mailbox#postie@agentspoppy.com"))).toBeTruthy();

    const off = await handler({ kind: "mailbox", email: "postie@agentspoppy.com", agentOwned: false } as never);
    expect(off.status).toBe("mailbox: released");
    expect(state.items.get(key("config", "mailbox#postie@agentspoppy.com"))).toBeFalsy();
  });

  it("refuses a malformed address rather than storing junk", async () => {
    const r = await handler({ kind: "mailbox", email: "not an address", agentOwned: true } as never);
    expect(r.ok).toBe(false);
    expect([...state.items.keys()].filter((k) => k.includes("mailbox#"))).toHaveLength(0);
  });

  it("an arriving mail self-heals the registry even without a toggle event", async () => {
    // A mailbox flagged before the registry existed must still appear in the SELECT.
    state.items.set(key("config", "owner-email"), { pk: "config", sk: "owner-email", email: "marco@example.com" });
    state.items.set(key(AGENTS_PK, agentSk("m1")), {
      pk: AGENTS_PK, sk: agentSk("m1"), ...agent, id: "m1", emailFrom: "postie@agentspoppy.com",
    });
    await handler({
      kind: "mail", to: "postie@agentspoppy.com", from: "marco@example.com",
      text: "hello", messageId: "heal-1",
      verdicts: { spf: "PASS", dkim: "PASS", spam: "PASS" },
    } as never);
    expect(state.items.get(key("config", "mailbox#postie@agentspoppy.com"))).toBeTruthy();
  });
});

describe("Memory means the chat continues (founder, 2026-07-31)", () => {
  const pastRun = (n: number, over: Record<string, unknown> = {}) => {
    const runId = `r${n}`;
    state.items.set(key(agentPk("a1"), `run#${runId}`), {
      pk: agentPk("a1"),
      sk: `run#${runId}`,
      runId,
      agentId: "a1",
      status: "succeeded",
      input: `question ${n}`,
      output: `answer ${n}`,
      cost: { usage: { inputTokens: 1, outputTokens: 1 } },
      iterations: 1,
      startedAt: `2026-07-30T10:0${n}:00.000Z`,
      modelId: agent.modelId,
      ...over,
    });
  };
  const memoryAgent = (tools: string[] = ["memory_read", "memory_write"]) =>
    state.items.set(key(AGENTS_PK, agentSk("a1")), {
      pk: AGENTS_PK, sk: agentSk("a1"), ...agent, tools,
    });

  it("hands the model the earlier exchanges, oldest first", async () => {
    pastRun(1);
    pastRun(2);
    const messages = (await recentExchanges(TABLE, "a1", "current")) as { role: string; content: string }[];
    expect(messages.map((m) => m.content)).toEqual([
      "question 1", "answer 1", "question 2", "answer 2",
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("never replays the CURRENT run, nor any run that has no answer", async () => {
    pastRun(1);
    pastRun(2, { status: "running", output: undefined });
    pastRun(3, { status: "failed", output: undefined });
    const messages = (await recentExchanges(TABLE, "a1", "r1")) as { content: string }[];
    // r1 is the current run; r2 and r3 never produced an answer.
    expect(messages).toBeUndefined();
  });

  it("caps how much it carries — every carried word is billed again (DESIGN §7)", async () => {
    for (let i = 1; i <= RECALL_EXCHANGES + 4; i++) pastRun(i);
    const messages = (await recentExchanges(TABLE, "a1", "current")) as unknown[];
    expect(messages).toHaveLength(RECALL_EXCHANGES * 2);
  });

  it("keeps the NEWEST exchanges when the character budget runs out", async () => {
    const big = "x".repeat(RECALL_CHARS);
    pastRun(1, { input: big, output: big }); // alone, far over budget
    pastRun(2);
    const messages = (await recentExchanges(TABLE, "a1", "current")) as { content: string }[];
    expect(messages.map((m) => m.content)).toEqual(["question 2", "answer 2"]);
  });

  it("an agent WITHOUT memory still starts every run fresh", async () => {
    pastRun(1);
    await handler({ runId: "new", agentId: "a1", input: "next question", tableName: TABLE } as never);
    const body = JSON.parse(String(state.invocations[0]!.body));
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe("next question");
  });

  it("an agent WITH memory sees what was said before", async () => {
    memoryAgent();
    pastRun(1);
    await handler({ runId: "new", agentId: "a1", input: "next question", tableName: TABLE } as never);
    const body = JSON.parse(String(state.invocations[0]!.body));
    expect(body.messages.map((m: { content: unknown }) => m.content)).toEqual([
      "question 1", "answer 1", "next question",
    ]);
  });

  it("read-only memory is enough to remember the conversation", async () => {
    memoryAgent(["memory_read"]);
    pastRun(1);
    await handler({ runId: "new", agentId: "a1", input: "next question", tableName: TABLE } as never);
    const body = JSON.parse(String(state.invocations[0]!.body));
    expect(body.messages).toHaveLength(3);
  });
});

// §15i: pushPing's answer is what decides the dead-phone email fallback, so what it
// reports has to be the truth — "delivered" ONLY when the relay says a phone buzzed.
describe("pushPing tells the truth about whether a phone buzzed", () => {
  const optIn = () =>
    state.items.set(key("config", "push"), {
      pk: "config", sk: "push", enabled: true, poolId: "eu-west-1_x",
      relayUrl: "https://agentspoppy.com/",
    });
  const relaySays = (body: unknown, ok = true) =>
    vi.fn(async () => ({ ok, json: async () => body }));

  afterEach(() => vi.unstubAllGlobals());

  it("is silent without the opt-in row — and never contacts the relay", async () => {
    const fetchMock = relaySays({ delivered: 5 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await pushPing(TABLE, "Emma", "approval")).toBe("silent");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is delivered when the relay reached a phone", async () => {
    optIn();
    vi.stubGlobal("fetch", relaySays({ ok: true, delivered: 1 }));
    expect(await pushPing(TABLE, "Emma", "approval")).toBe("delivered");
  });

  it("is silent when the relay reached NOBODY — deleted app, lapsed plan", async () => {
    optIn();
    vi.stubGlobal("fetch", relaySays({ ok: true, delivered: 0 }));
    expect(await pushPing(TABLE, "Emma", "approval")).toBe("silent");
  });

  it("is silent when the relay errors or answers rubbish", async () => {
    optIn();
    vi.stubGlobal("fetch", relaySays({}, false));
    expect(await pushPing(TABLE, "Emma", "waiting")).toBe("silent");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })));
    expect(await pushPing(TABLE, "Emma", "waiting")).toBe("silent");
  });
});
