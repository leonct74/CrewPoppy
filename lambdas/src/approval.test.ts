// The internet-facing endpoint gets tested like what it is: a door strangers can knock
// on. Every test here is about what the door does NOT do.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  AGENTS_PK, CHECKPOINT_SK, agentPk, agentSk, checkpointPk, runSk,
} from "@crewpoppy/shared";

const state = vi.hoisted(() => ({
  items: new Map<string, Record<string, unknown>>(),
  invokes: [] as Record<string, unknown>[],
  /** Conditional updates already applied, to enforce single-use like DynamoDB does. */
  used: new Set<string>(),
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
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: Cmd) {
          const n = cmd.constructor.name;
          if (n === "GetCommand") return { Item: state.items.get(key(cmd.input.Key.pk, cmd.input.Key.sk)) };
          if (n === "PutCommand") {
            state.items.set(key(cmd.input.Item.pk, cmd.input.Item.sk), cmd.input.Item);
            return {};
          }
          if (n === "UpdateCommand") {
            const k = key(cmd.input.Key.pk, cmd.input.Key.sk);
            if (cmd.input.ConditionExpression?.includes("attribute_not_exists(approvalUsedAt)")) {
              if (state.used.has(k)) {
                throw Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" });
              }
              state.used.add(k);
            }
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
        state.invokes.push(cmd.input);
        return {};
      }
    },
  };
});

const { handler } = await import("./approval");

const TABLE = "CrewPoppyData";
const TOKEN = "a".repeat(64);
const HASH = createHash("sha256").update(TOKEN).digest("hex");

function seed(over: { cp?: Record<string, unknown>; run?: Record<string, unknown> } = {}) {
  state.items.set(key(checkpointPk("r1"), CHECKPOINT_SK), {
    pk: checkpointPk("r1"), sk: CHECKPOINT_SK,
    runId: "r1", agentId: "a1",
    question: "Postie wants to email jane@customer.test.",
    pending: { kind: "send_email", to: "jane@customer.test", subject: "Offer", body: "Dear Jane…", attach: "offer.pdf" },
    approvalHash: HASH,
    approvalExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    messages: [], usage: { inputTokens: 0, outputTokens: 0 }, iterations: 1,
    startedAt: "2026-07-28T10:00:00.000Z", nextSeq: 5, expiresAt: 0,
    ...(over.cp ?? {}),
  });
  state.items.set(key(agentPk("a1"), runSk("r1")), {
    pk: agentPk("a1"), sk: runSk("r1"),
    runId: "r1", agentId: "a1", status: "waiting", input: "make the offer",
    cost: { usage: { inputTokens: 0, outputTokens: 0 } }, iterations: 1,
    startedAt: "2026-07-28T10:00:00.000Z", modelId: "m",
    ...(over.run ?? {}),
  });
  state.items.set(key(AGENTS_PK, agentSk("a1")), { pk: AGENTS_PK, sk: agentSk("a1"), id: "a1", name: "Postie" });
}

const req = (method: string, path: string, body?: string) => ({
  rawPath: path,
  requestContext: { http: { method } },
  ...(body ? { body, isBase64Encoded: false } : {}),
});

beforeEach(() => {
  state.items.clear();
  state.invokes = [];
  state.used.clear();
  process.env.CREWPOPPY_TABLE = TABLE;
});

describe("GET — render only", () => {
  it("shows the exact message awaiting approval, with the attachment named", async () => {
    seed();
    const r = await handler(req("GET", `/a/r1/${TOKEN}`) as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("jane@customer.test");
    expect(r.body).toContain("Dear Jane…");
    expect(r.body).toContain("offer.pdf");
    expect(r.body).toContain("Postie");
  });

  it("changes NOTHING — a prefetching mail scanner is harmless here", async () => {
    seed();
    await handler(req("GET", `/a/r1/${TOKEN}`) as never);
    await handler(req("GET", `/a/r1/${TOKEN}`) as never);
    expect(state.invokes).toHaveLength(0);
    expect(state.used.size).toBe(0);
    const run = state.items.get(key(agentPk("a1"), runSk("r1")))!;
    expect(run.status).toBe("waiting");
  });

  it("escapes agent-authored content — a draft can't script the approval page", async () => {
    seed({ cp: { pending: { kind: "send_email", to: "j@x.test", subject: "<script>alert(1)</script>", body: "<img onerror=x>" } } });
    const r = await handler(req("GET", `/a/r1/${TOKEN}`) as never);
    expect(r.body).not.toContain("<script>");
    expect(r.body).not.toContain("<img");
  });
});

describe("every invalid link looks the same", () => {
  it("wrong token, unknown run, expired, used, already answered — one identical page", async () => {
    seed();
    const bodies = new Set<string>();
    bodies.add((await handler(req("GET", `/a/r1/${"b".repeat(64)}`) as never)).body); // wrong token
    bodies.add((await handler(req("GET", `/a/nope/${TOKEN}`) as never)).body); // unknown run
    seed({ cp: { approvalExpiresAt: Math.floor(Date.now() / 1000) - 10 } });
    bodies.add((await handler(req("GET", `/a/r1/${TOKEN}`) as never)).body); // expired
    seed({ cp: { approvalUsedAt: "2026-07-28T11:00:00.000Z" } });
    bodies.add((await handler(req("GET", `/a/r1/${TOKEN}`) as never)).body); // used
    seed({ run: { status: "succeeded" } });
    bodies.add((await handler(req("GET", `/a/r1/${TOKEN}`) as never)).body); // answered on desktop
    expect(bodies.size).toBe(1); // probing teaches nothing
    // …and none of them leak what was waiting.
    expect([...bodies][0]).not.toContain("jane@customer.test");
  });
});

describe("POST — the one answer", () => {
  it("approve resumes the runner with the approved flag, exactly like the desktop button", async () => {
    seed();
    const r = await handler(req("POST", `/a/r1/${TOKEN}`, "action=approve") as never);
    expect(r.statusCode).toBe(200);
    expect(state.invokes).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(state.invokes[0]!.Payload as Buffer).toString());
    expect(payload.approved).toBe(true);
    expect(payload.runId).toBe("r1");
    const run = state.items.get(key(agentPk("a1"), runSk("r1")))!;
    expect(run.status).toBe("running");
  });

  it("deny resumes WITHOUT the approved flag — nothing gets sent", async () => {
    seed();
    await handler(req("POST", `/a/r1/${TOKEN}`, "action=deny") as never);
    const payload = JSON.parse(Buffer.from(state.invokes[0]!.Payload as Buffer).toString());
    expect(payload.approved).toBeUndefined();
    expect(payload.answer).toMatch(/denied/i);
  });

  it("is SINGLE USE: the second POST does nothing, atomically", async () => {
    seed();
    await handler(req("POST", `/a/r1/${TOKEN}`, "action=approve") as never);
    // Simulate the run still looking answerable — only the conditional write may decide.
    const run = state.items.get(key(agentPk("a1"), runSk("r1")))!;
    run.status = "waiting";
    const r2 = await handler(req("POST", `/a/r1/${TOKEN}`, "action=approve") as never);
    expect(r2.statusCode).toBe(404);
    expect(state.invokes).toHaveLength(1); // the runner was resumed exactly once
  });

  it("a nonsense action is a refusal, not an approval", async () => {
    seed();
    const r = await handler(req("POST", `/a/r1/${TOKEN}`, "action=yes-please") as never);
    expect(r.statusCode).toBe(404);
    expect(state.invokes).toHaveLength(0);
  });
});
