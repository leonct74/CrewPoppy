// The mobile door gets tested like what it is: an internet-facing endpoint whose one
// lock is the Cognito token check. Half of these tests are about what the door does NOT
// do — and the signature path runs REAL crypto (a generated RSA keypair), not a mocked
// verifier, because "verify" is exactly the code a mock would exempt from testing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  AGENTS_PK, CHECKPOINT_SK, agentSk, agentPk, checkpointPk, runSk, spendPk, spendSk,
  transcriptPk, transcriptSk, type AgentDef, type RunRecord,
} from "@crewpoppy/shared";

const state = vi.hoisted(() => ({
  items: new Map<string, Record<string, any>>(),
  invokes: [] as Record<string, unknown>[],
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
    QueryCommand: class extends Cmd {},
    DeleteCommand: class extends Cmd {},
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: Cmd) {
          const n = cmd.constructor.name;
          if (n === "GetCommand") return { Item: state.items.get(key(cmd.input.Key.pk, cmd.input.Key.sk)) };
          if (n === "PutCommand") {
            state.items.set(key(cmd.input.Item.pk, cmd.input.Item.sk), cmd.input.Item);
            return {};
          }
          if (n === "DeleteCommand") {
            state.items.delete(key(cmd.input.Key.pk, cmd.input.Key.sk));
            return {};
          }
          if (n === "QueryCommand") {
            const pk = cmd.input.ExpressionAttributeValues[":pk"];
            const prefix = cmd.input.ExpressionAttributeValues[":sk"];
            let items = [...state.items.values()]
              .filter((i) => i.pk === pk && (!prefix || String(i.sk).startsWith(prefix)))
              .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
            if (cmd.input.ScanIndexForward === false) items = items.reverse();
            if (cmd.input.Limit) items = items.slice(0, cmd.input.Limit);
            return { Items: items };
          }
          return {};
        },
      }),
    },
  };
});
vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: Record<string, any>) {}
  }
  return {
    InvokeCommand,
    LambdaClient: class {
      async send(cmd: InvokeCommand) {
        state.invokes.push(JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8")));
        return {};
      }
    },
  };
});

import { handler, resetJwksCache, verifyAccessToken, type UrlEvent } from "./mobile-api";

// ---- a real signing pool: one honest keypair, one attacker keypair ------------------

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1" };

const POOL = "eu-west-1_TESTPOOL";
const CLIENT = "client-abc-123";
const ISSUER = `https://cognito-idp.eu-west-1.amazonaws.com/${POOL}`;

const b64u = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makeToken(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; alg?: string; signer?: typeof privateKey } = {},
): string {
  const header = { kid: opts.kid ?? "k1", alg: opts.alg ?? "RS256" };
  const payload = {
    sub: "owner-sub",
    iss: ISSUER,
    exp: Math.floor(Date.now() / 1000) + 3600,
    token_use: "access",
    client_id: CLIENT,
    username: "owner",
    ...claims,
  };
  const signing = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(payload)))}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(signing), opts.signer ?? privateKey);
  return `${signing}.${b64u(sig)}`;
}

function req(method: string, path: string, body?: unknown, token?: string | null): UrlEvent {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: token === null ? {} : { authorization: `Bearer ${token ?? makeToken()}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "emma",
  name: "Emma",
  role: "Research Assistant",
  instructions: "Research things.",
  modelId: "anthropic.claude-3-haiku",
  tools: [],
  caps: { maxIterations: 8, maxTokensPerRun: 20_000, maxWallClockMs: 120_000, monthlySpendCapUsd: 10 },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});
const putAgent = (a: AgentDef) => state.items.set(key(AGENTS_PK, agentSk(a.id)), { pk: AGENTS_PK, sk: agentSk(a.id), ...a });
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: "r1",
  agentId: "emma",
  status: "succeeded",
  input: "do the thing",
  cost: { usage: { inputTokens: 10, outputTokens: 20 } },
  iterations: 1,
  startedAt: new Date().toISOString(),
  modelId: "anthropic.claude-3-haiku",
  ...over,
});
const putRun = (r: RunRecord) =>
  state.items.set(key(agentPk(r.agentId), runSk(r.runId)), { pk: agentPk(r.agentId), sk: runSk(r.runId), ...r });

beforeEach(() => {
  state.items.clear();
  state.invokes.length = 0;
  resetJwksCache();
  process.env.CREWPOPPY_TABLE = "CrewPoppyData";
  process.env.CREWPOPPY_RUNNER = "CrewPoppyRunner";
  process.env.MOBILE_USER_POOL_ID = POOL;
  process.env.MOBILE_CLIENT_ID = CLIENT;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ keys: [JWK] }) })));
});

describe("the lock (verifyAccessToken + the handler's wall)", () => {
  it("accepts a genuine access token", async () => {
    expect(await verifyAccessToken(makeToken(), POOL, CLIENT, "eu-west-1")).toEqual({
      sub: "owner-sub",
      username: "owner",
    });
  });

  it.each([
    ["no header at all", () => req("GET", "/agents", undefined, null)],
    ["a garbage token", () => req("GET", "/agents", undefined, "not.a.jwt")],
    ["a token signed by someone else's key", () => req("GET", "/agents", undefined, makeToken({}, { signer: attacker.privateKey }))],
    ["an expired token", () => req("GET", "/agents", undefined, makeToken({ exp: Math.floor(Date.now() / 1000) - 10 }))],
    ["an ID token where an access token belongs", () => req("GET", "/agents", undefined, makeToken({ token_use: "id" }))],
    ["a token for a different app client", () => req("GET", "/agents", undefined, makeToken({ client_id: "other-client" }))],
    ["a token from a different pool", () => req("GET", "/agents", undefined, makeToken({ iss: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_OTHER" }))],
    ["an alg:none token", () => req("GET", "/agents", undefined, makeToken({}, { alg: "none" }))],
    ["an unknown signing key", () => req("GET", "/agents", undefined, makeToken({}, { kid: "k999" }))],
  ])("answers 401 to %s — and the same 401 every time", async (_name, make) => {
    const res = await handler(make());
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe(JSON.stringify({ error: "unauthorized" }));
  });

  it("refetches the JWKS once on an unknown kid (key rotation), then gives up", async () => {
    await handler(req("GET", "/agents", undefined, makeToken({}, { kid: "k999" })));
    // Initial fetch + one rotation refetch — never a loop an attacker can drive.
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    // And every call went to OUR pool's well-known URL, never one named by the token.
    for (const call of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe(`${ISSUER}/.well-known/jwks.json`);
    }
  });
});

describe("GET /agents — the home screen", () => {
  it("returns the crew with month spend and the latest run", async () => {
    putAgent(agent({ avatar: "av-07" }));
    state.items.set(key(spendPk("emma"), spendSk(new Date().toISOString().slice(0, 7))), {
      pk: spendPk("emma"), sk: spendSk(new Date().toISOString().slice(0, 7)), usd: 1.25,
    });
    putRun(run({ status: "waiting" }));
    const res = await handler(req("GET", "/agents"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      id: "emma", name: "Emma", role: "Research Assistant", avatar: "av-07", monthSpendUsd: 1.25,
    });
    expect(body.agents[0].latestRun.status).toBe("waiting");
    // The brief (system prompt) stays on the desktop — the phone list doesn't need it.
    expect(body.agents[0].instructions).toBeUndefined();
  });

  it("heals a run that never reported back, same rule as the desktop and the ticker", async () => {
    putAgent(agent());
    putRun(run({ status: "running", startedAt: new Date(Date.now() - 999_000).toISOString() }));
    const body = JSON.parse((await handler(req("GET", "/agents"))).body);
    expect(body.agents[0].latestRun.status).toBe("failed");
  });
});

describe("runs: history, detail, start", () => {
  it("404s an agent that doesn't exist — same shape as any other miss", async () => {
    expect((await handler(req("GET", "/agents/nobody/runs"))).statusCode).toBe(404);
  });

  it("lists an agent's runs newest-first", async () => {
    putAgent(agent());
    putRun(run({ runId: "r1", startedAt: "2026-07-29T10:00:00.000Z" }));
    putRun(run({ runId: "r2", startedAt: "2026-07-30T10:00:00.000Z" }));
    const body = JSON.parse((await handler(req("GET", "/agents/emma/runs"))).body);
    expect(body.runs.map((r: RunRecord) => r.runId)).toEqual(["r2", "r1"]);
  });

  it("returns run detail with transcript, and the question+pending from the checkpoint when waiting", async () => {
    putAgent(agent());
    putRun(run({ status: "waiting" }));
    state.items.set(key(transcriptPk("r1"), transcriptSk(1)), { pk: transcriptPk("r1"), sk: transcriptSk(1), seq: 1, role: "user", text: "do the thing" });
    state.items.set(key(checkpointPk("r1"), CHECKPOINT_SK), {
      pk: checkpointPk("r1"), sk: CHECKPOINT_SK, runId: "r1", agentId: "emma",
      question: "Send this?", pending: { kind: "send_email", to: "x@y.z", subject: "Hi", body: "Hello" },
    });
    const body = JSON.parse((await handler(req("GET", "/agents/emma/runs/r1"))).body);
    expect(body.transcript).toHaveLength(1);
    expect(body.question).toBe("Send this?");
    // Read from the SAME row the runner sends from — what you approve is what goes out.
    expect(body.pending.to).toBe("x@y.z");
  });

  it("starts a run: row written first, then the runner invoked with the exact desktop contract", async () => {
    putAgent(agent());
    const res = await handler(req("POST", "/agents/emma/runs", { input: "  write the report  " }));
    expect(res.statusCode).toBe(200);
    const { run: started } = JSON.parse(res.body);
    expect(started.status).toBe("running");
    expect(started.input).toBe("write the report");
    expect(state.items.get(key(agentPk("emma"), runSk(started.runId)))).toBeTruthy();
    expect(state.invokes).toEqual([
      { runId: started.runId, agentId: "emma", input: "write the report", tableName: "CrewPoppyData" },
    ]);
  });

  it("refuses an empty task", async () => {
    putAgent(agent());
    expect((await handler(req("POST", "/agents/emma/runs", { input: "   " }))).statusCode).toBe(400);
    expect(state.invokes).toHaveLength(0);
  });
});

describe("answer — approval is a BUTTON FLAG, never words (§4c)", () => {
  beforeEach(() => {
    putAgent(agent());
    putRun(run({ status: "waiting" }));
  });

  it("resumes a waiting run with the answer", async () => {
    const res = await handler(req("POST", "/agents/emma/runs/r1/answer", { answer: "go ahead", approved: true }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).run.status).toBe("running");
    expect(state.invokes[0]).toMatchObject({ runId: "r1", answer: "go ahead", approved: true });
  });

  it.each([
    ["the string 'true'", "true"],
    ["the string 'yes'", "yes"],
    ["the number 1", 1],
    ["an object", { pressed: true }],
  ])("drops approved when it is %s — only the literal boolean approves", async (_n, value) => {
    await handler(req("POST", "/agents/emma/runs/r1/answer", { answer: "yes do it", approved: value }));
    // The answer travels; the approval flag does NOT — words never approve.
    expect(state.invokes[0]).toMatchObject({ runId: "r1", answer: "yes do it" });
    expect("approved" in state.invokes[0]!).toBe(false);
  });

  it("409s a run that isn't waiting — answering can't restart finished work", async () => {
    putRun(run({ status: "succeeded" }));
    expect((await handler(req("POST", "/agents/emma/runs/r1/answer", { answer: "hi" }))).statusCode).toBe(409);
    expect(state.invokes).toHaveLength(0);
  });
});

describe("stop — the kill switch from the phone", () => {
  it("marks a running run stopped and says the phone did it", async () => {
    putAgent(agent());
    putRun(run({ status: "running" }));
    const body = JSON.parse((await handler(req("POST", "/agents/emma/runs/r1/stop"))).body);
    expect(body.run.status).toBe("stopped");
    expect(body.run.message).toMatch(/from your phone/);
    expect((state.items.get(key(agentPk("emma"), runSk("r1"))) as RunRecord).status).toBe("stopped");
  });

  it("leaves a finished run alone — stopping twice is safe", async () => {
    putAgent(agent());
    putRun(run({ status: "succeeded" }));
    const body = JSON.parse((await handler(req("POST", "/agents/emma/runs/r1/stop"))).body);
    expect(body.run.status).toBe("succeeded");
  });
});

describe("clearing a chat from the phone (founder, 2026-07-31)", () => {
  beforeEach(() => {
    putAgent(agent());
    putRun(run({ runId: "r1", status: "succeeded" }));
    state.items.set(key(transcriptPk("r1"), transcriptSk(1)), {
      pk: transcriptPk("r1"), sk: transcriptSk(1), seq: 1, role: "user", text: "hi",
    });
    state.items.set(key(checkpointPk("r1"), CHECKPOINT_SK), {
      pk: checkpointPk("r1"), sk: CHECKPOINT_SK, runId: "r1", agentId: "emma",
    });
    // The things that must SURVIVE a tidy-up.
    state.items.set(key(spendPk("emma"), spendSk("2026-07")), {
      pk: spendPk("emma"), sk: spendSk("2026-07"), usd: 4.2,
    });
  });

  it("removes runs, transcripts and checkpoints", async () => {
    const res = await handler(req("DELETE", "/agents/emma/history"));
    expect(res.statusCode).toBe(200);
    expect(state.items.get(key(agentPk("emma"), runSk("r1")))).toBeUndefined();
    expect(state.items.get(key(transcriptPk("r1"), transcriptSk(1)))).toBeUndefined();
    expect(state.items.get(key(checkpointPk("r1"), CHECKPOINT_SK))).toBeUndefined();
  });

  it("NEVER touches the spend counters — tidying can't reset a cost cap", async () => {
    await handler(req("DELETE", "/agents/emma/history"));
    expect(state.items.get(key(spendPk("emma"), spendSk("2026-07")))).toMatchObject({ usd: 4.2 });
    // …nor the agent itself.
    expect(state.items.get(key(AGENTS_PK, agentSk("emma")))).toBeTruthy();
  });

  it.each([
    ["running", /working right now/],
    ["waiting", /waiting for your answer/],
  ])("refuses while a run is %s, and explains why", async (status, expected) => {
    putRun(run({ runId: "r2", status: status as "running" | "waiting" }));
    const res = await handler(req("DELETE", "/agents/emma/history"));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(expected);
    // Nothing was removed by the refused call.
    expect(state.items.get(key(agentPk("emma"), runSk("r1")))).toBeTruthy();
  });

  it("still requires a valid token", async () => {
    expect((await handler(req("DELETE", "/agents/emma/history", undefined, null))).statusCode).toBe(401);
  });
});

describe("what the door does NOT expose", () => {
  it("404s everything that isn't the five read/use routes — no create, edit or delete", async () => {
    putAgent(agent());
    for (const [method, path] of [
      ["POST", "/agents"], // creating agents is the DESKTOP's job (§15 scope rule)
      ["DELETE", "/agents/emma"],
      ["PUT", "/agents/emma"],
      ["GET", "/config"],
      ["GET", "/"],
    ] as const) {
      const res = await handler(req(method, path, {}));
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
  });

  it("rejects path ids that aren't plain ids", async () => {
    expect((await handler(req("GET", "/agents/../runs"))).statusCode).toBe(404);
  });
});
