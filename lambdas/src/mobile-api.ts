// The mobile API (DESIGN §15h M1) — the phone's window onto the crew, in the owner's
// own AWS. Internet-facing like the approval endpoint, but a different lock: every
// request must carry a Cognito ACCESS TOKEN, verified here in code against the pool's
// public signing keys before a single row is read. There is no API Gateway in front —
// a Function URL plus ~80 lines of RS256 is the same wall without the packed-policy
// weight (§2b), and without a single new manifest action beyond cognito-idp.
//
// What the phone may do is deliberately the USE half of the §15 scope rule ("the phone
// USES the crew, the desktop EXPANDS it"): list agents, read runs and transcripts,
// start a run, answer/approve, stop. No create/edit/delete of agents, no workspace
// writes, no settings. The role behind this function matches: table + invoke runner,
// nothing else.
//
// Approval stays a BUTTON FLAG (§4c): `approved` is forwarded ONLY as the literal
// boolean true, exactly like the desktop and the email link. Words never approve.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  AGENTS_PK,
  CHECKPOINT_SK,
  CONFIG_PK,
  PUSH_SK,
  agentPk,
  agentSk,
  checkpointPk,
  monthKeyOf,
  neverReportedBack,
  newestFirst,
  isSafeRelativePath,
  runSk,
  spendPk,
  spendSk,
  transcriptPk,
  workspaceKeyFor,
  type AgentDef,
  type PendingSend,
  type RunCheckpoint,
  type RunRecord,
  type TranscriptEntry,
} from "@crewpoppy/shared";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const lambda = new LambdaClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

// ---------------------------------------------------------------------------- auth --

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

/**
 * The pool's signing keys, cached for the life of the container. Refetched once when a
 * token names a kid we don't hold (key rotation); an attacker-controlled kid therefore
 * costs at most one extra fetch of a public document, never a different trust root —
 * the URL is built from OUR pool id, not from anything in the token.
 */
let jwksCache: Jwk[] | null = null;

async function fetchJwks(issuer: string): Promise<Jwk[]> {
  const res = await fetch(`${issuer}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Verify a Cognito access token and return its claims, or null. One null for every
 * failure mode — malformed, wrong algorithm, unknown key, bad signature, expired,
 * wrong pool, wrong client, an ID token where an access token belongs — so a probe
 * learns nothing about which wall it hit.
 */
export async function verifyAccessToken(
  token: string,
  poolId: string,
  clientId: string,
  region: string,
): Promise<{ sub: string; username?: string } | null> {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const header = JSON.parse(b64url(h).toString("utf8")) as { kid?: string; alg?: string };
    // RS256 only. Accepting the token's own choice of algorithm is the classic JWT
    // vulnerability ("alg":"none", or HS256 keyed with the public key).
    if (header.alg !== "RS256" || !header.kid) return null;

    const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
    if (!jwksCache) jwksCache = await fetchJwks(issuer);
    let jwk = jwksCache.find((k) => k.kid === header.kid);
    if (!jwk) {
      jwksCache = await fetchJwks(issuer); // rotation: refetch once, then give up
      jwk = jwksCache.find((k) => k.kid === header.kid);
      if (!jwk) return null;
    }

    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    if (!cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64url(s))) return null;

    const claims = JSON.parse(b64url(p).toString("utf8")) as {
      sub?: string;
      iss?: string;
      exp?: number;
      token_use?: string;
      client_id?: string;
      username?: string;
    };
    if (claims.iss !== issuer) return null;
    if (!claims.exp || Date.now() / 1000 >= claims.exp) return null;
    // An ACCESS token, from OUR app client. An ID token also passes signature+issuer —
    // but it authenticates a session with our client, not a request to this API.
    if (claims.token_use !== "access") return null;
    if (claims.client_id !== clientId) return null;
    if (!claims.sub) return null;
    return { sub: claims.sub, username: claims.username };
  } catch {
    return null;
  }
}

/** Test seam: clear the container-lifetime key cache between cases. */
export function resetJwksCache(): void {
  jwksCache = null;
}

// ------------------------------------------------------------------------- handler --

export interface UrlEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

const UNAUTHORIZED = json(401, { error: "unauthorized" });
const NOT_FOUND = json(404, { error: "not found" });

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The ceiling on one attached file. Generous enough for documents and photos, small
 * enough that a mis-tap can't fill the owner's bucket — and it is enforced when the
 * LINK is minted, so an oversized file never even starts uploading.
 */
export const MAX_UPLOAD_BYTES = 10_000_000;

async function getAgent(table: string, id: string): Promise<AgentDef | null> {
  const r = await ddb.send(new GetCommand({ TableName: table, Key: { pk: AGENTS_PK, sk: agentSk(id) } }));
  return (r.Item as AgentDef | undefined) ?? null;
}

async function getRun(table: string, agentId: string, runId: string): Promise<RunRecord | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: table, Key: { pk: agentPk(agentId), sk: runSk(runId) } }),
  );
  return (r.Item as RunRecord | undefined) ?? null;
}

/** The same staleness healing the desktop and the ticker apply (shared predicate). */
function healed(run: RunRecord, agent: AgentDef | null, now: number): RunRecord {
  if (!neverReportedBack(run, agent?.caps, now)) return run;
  return {
    ...run,
    status: "failed",
    stopReason: "error",
    message: "This run never reported back. Open CrewPoppy on your computer and check for an update.",
  };
}

async function monthSpendUsd(table: string, agentId: string, nowIso: string): Promise<number> {
  const r = await ddb.send(
    new GetCommand({ TableName: table, Key: { pk: spendPk(agentId), sk: spendSk(monthKeyOf(nowIso)) } }),
  );
  return Number((r.Item as { usd?: number } | undefined)?.usd ?? 0);
}

async function latestRun(table: string, agent: AgentDef, now: number): Promise<RunRecord | null> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": agentPk(agent.id), ":sk": "run#" },
    }),
  );
  // By the clock, never by the sort key — run ids are random UUIDs (§ newestFirst).
  // No Limit either: the "last" row by key order is not the last by time.
  const run = newestFirst((r.Items ?? []) as RunRecord[])[0] ?? null;
  return run ? healed(run, agent, now) : null;
}

/**
 * Every item in one partition, deleted one at a time — no BatchWriteItem grant needed
 * (the same choice, for the same reason, as the desktop's own deletePartition).
 */
async function deletePartition(table: string, pk: string): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (page.Items ?? []) as { pk: string; sk: string }[]) {
      await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: item.pk, sk: item.sk } }));
      count += 1;
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return count;
}

/** Start or resume the runner — the exact payload contract the desktop uses. */
async function invokeRunner(
  runner: string,
  payload: { runId: string; agentId: string; input: string; tableName: string; answer?: string; approved?: true },
): Promise<void> {
  await lambda.send(
    new InvokeCommand({
      FunctionName: runner,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

export async function handler(event: UrlEvent) {
  const table = process.env.CREWPOPPY_TABLE || "";
  const runner = process.env.CREWPOPPY_RUNNER || "CrewPoppyRunner";
  const poolId = process.env.MOBILE_USER_POOL_ID || "";
  const clientId = process.env.MOBILE_CLIENT_ID || "";
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";

  // The lock, before any routing: no valid token, no answers — not even "what routes
  // exist". Header names arrive lowercased from the Function URL runtime, but that is
  // a convention, not a contract, so both spellings are read.
  const auth = event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !poolId || !clientId) return UNAUTHORIZED;
  const who = await verifyAccessToken(token, poolId, clientId, REGION);
  if (!who) return UNAUTHORIZED;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // GET /agents — the home screen in one call: the crew, each with this month's spend
  // and its latest run (so the grid can say Working / Needs you truthfully).
  if (method === "GET" && path === "/agents") {
    const r = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": AGENTS_PK },
      }),
    );
    const defs = (r.Items ?? []) as AgentDef[];
    const agents = await Promise.all(
      defs.map(async (d) => ({
        id: d.id,
        name: d.name,
        role: d.role,
        avatar: d.avatar,
        modelId: d.modelId,
        caps: d.caps,
        // §15i: the app warns before push is switched off while an agent relies on it.
        approvalChannel: d.approvalChannel ?? "email",
        monthSpendUsd: await monthSpendUsd(table, d.id, nowIso),
        latestRun: await latestRun(table, d, now),
      })),
    );
    return json(200, { agents });
  }

  // PUT /push — the notification opt-in (DESIGN §15h M3). The PHONE owns this switch:
  // flipping it on records {enabled, poolId, relayUrl} in the owner's own table, and
  // the runner reads that row before it ever pings the relay. Off (or absent) means
  // the runner tells nobody anything — the documented default.
  if (method === "PUT" && path === "/push") {
    const body = parseBody(event);
    if (body.enabled === true) {
      const relayUrl = typeof body.relayUrl === "string" ? body.relayUrl.trim() : "";
      // Only OUR relay: this URL is where agent NAMES go when a run wants attention.
      // A free-form URL here would let a crafted client exfiltrate crew names to
      // anywhere — the allowlist keeps the blast radius at "our own service".
      if (!/^https:\/\/agentspoppy[a-z0-9.-]*\.(hosted\.app|com)\//.test(relayUrl)) {
        return json(400, { error: "That notification service isn't recognised." });
      }
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: { pk: CONFIG_PK, sk: PUSH_SK, enabled: true, poolId, relayUrl },
        }),
      );
      return json(200, { ok: true, enabled: true });
    }
    await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: CONFIG_PK, sk: PUSH_SK } }));
    return json(200, { ok: true, enabled: false });
  }
  if (method === "GET" && path === "/push") {
    const r = await ddb.send(
      new GetCommand({ TableName: table, Key: { pk: CONFIG_PK, sk: PUSH_SK } }),
    );
    return json(200, { enabled: (r.Item as { enabled?: boolean } | undefined)?.enabled === true });
  }

  // POST /agents/{id}/upload-url — a short-lived, single-file signed link so the phone
  // can put a document straight into THAT agent's workspace (founder, 2026-07-31).
  //
  // Why a signed link and not a plain upload: a Lambda request tops out around 6 MB and
  // the file would be base64'd on the way in, so a phone photo could fail on size alone.
  // The bytes go phone → the owner's own bucket, touching nothing in between. The link
  // is minted for ONE key — this agent's prefix, this filename — so it cannot be
  // replayed to write anywhere else, and it expires in five minutes.
  const up = /^\/agents\/([^/]+)\/upload-url$/.exec(path);
  if (up && method === "POST") {
    const id = up[1]!;
    if (!ID.test(id)) return NOT_FOUND;
    const agent = await getAgent(table, id);
    if (!agent) return NOT_FOUND;
    const bucket = process.env.CREWPOPPY_WORKSPACE_BUCKET || "";
    if (!bucket) return json(500, { error: "This deployment has no workspace bucket." });

    const body = parseBody(event);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    // The SAME traversal rule the model's own writes go through: the owner is trusted,
    // a filename arriving over the wire is a string like any other.
    if (!isSafeRelativePath(name) || name.includes("/") || name.includes("\\")) {
      return json(400, { error: "That file name isn't allowed. Use a plain name, with no folders." });
    }
    const size = Number(body.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) return json(400, { error: "That file looks empty." });
    if (size > MAX_UPLOAD_BYTES) {
      return json(400, {
        error: `That file is too big (limit ${Math.round(MAX_UPLOAD_BYTES / 1_000_000)} MB).`,
      });
    }

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: workspaceKeyFor(id, name),
        ContentType: typeof body.contentType === "string" ? body.contentType : "application/octet-stream",
      }),
      { expiresIn: 300 },
    );
    return json(200, { url, name });
  }

  // DELETE /agents/{id}/history — clear this chat (founder, 2026-07-31). Exactly the
  // desktop's clearHistory semantics: runs, their transcripts and their checkpoints go;
  // the agent, its memory, its files and its SPEND COUNTERS stay, because tidying a
  // conversation must never hand an agent a fresh budget. A live run refuses.
  const h = /^\/agents\/([^/]+)\/history$/.exec(path);
  if (h && method === "DELETE") {
    const id = h[1]!;
    if (!ID.test(id)) return NOT_FOUND;
    const agent = await getAgent(table, id);
    if (!agent) return NOT_FOUND;

    const listed = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: { ":pk": agentPk(id), ":sk": "run#" },
      }),
    );
    const runs = ((listed.Items ?? []) as RunRecord[]).map((r) => healed(r, agent, now));
    const live = runs.find((r) => r.status === "running" || r.status === "waiting");
    if (live) {
      return json(409, {
        error:
          live.status === "waiting"
            ? `${agent.name} is waiting for your answer. Answer or stop that run first.`
            : `${agent.name} is working right now. Stop the run first.`,
      });
    }

    for (const r of runs) {
      await deletePartition(table, transcriptPk(r.runId));
      await ddb.send(
        new DeleteCommand({ TableName: table, Key: { pk: checkpointPk(r.runId), sk: CHECKPOINT_SK } }),
      );
    }
    const removed = await deletePartition(table, agentPk(id));
    return json(200, { ok: true, removed: { runs: removed } });
  }

  const m = /^\/agents\/([^/]+)\/runs(?:\/([^/]+))?(?:\/(answer|stop))?$/.exec(path);
  if (!m) return NOT_FOUND;
  const [, agentId, runId, action] = m;
  if (!ID.test(agentId!) || (runId && !ID.test(runId))) return NOT_FOUND;

  const agent = await getAgent(table, agentId!);
  if (!agent) return NOT_FOUND;

  // GET /agents/{id}/runs — history, newest first, staleness healed like everywhere.
  if (method === "GET" && !runId) {
    const r = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: { ":pk": agentPk(agent.id), ":sk": "run#" },
      }),
    );
    return json(200, {
      runs: newestFirst((r.Items ?? []) as RunRecord[]).map((x) => healed(x, agent, now)),
    });
  }

  // POST /agents/{id}/runs — start a run. Same order as the desktop: record FIRST,
  // then the async invoke, so a phone that loses signal immediately still owns the run.
  if (method === "POST" && !runId) {
    const body = parseBody(event);
    const input = typeof body.input === "string" ? body.input.trim().slice(0, 20_000) : "";
    if (!input) return json(400, { error: "A task is required." });
    const newRunId = globalThis.crypto.randomUUID();
    const record: RunRecord = {
      runId: newRunId,
      agentId: agent.id,
      status: "running",
      input,
      cost: { usage: { inputTokens: 0, outputTokens: 0 } },
      iterations: 0,
      startedAt: nowIso,
      modelId: agent.modelId,
    };
    await ddb.send(
      new PutCommand({ TableName: table, Item: { pk: agentPk(agent.id), sk: runSk(newRunId), ...record } }),
    );
    await invokeRunner(runner, { runId: newRunId, agentId: agent.id, input, tableName: table });
    return json(200, { run: record });
  }

  if (!runId) return NOT_FOUND;
  const run = await getRun(table, agent.id, runId);
  if (!run) return NOT_FOUND;

  // GET /agents/{id}/runs/{runId} — the chat: run, transcript, and (when waiting) the
  // question plus any proposed send, read from the SAME checkpoint row the runner will
  // execute from, so what the phone shows and what goes out cannot drift (§4c).
  if (method === "GET" && !action) {
    const t = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": transcriptPk(runId) },
      }),
    );
    let question: string | undefined;
    let pending: PendingSend | undefined;
    if (run.status === "waiting") {
      const cp = (
        await ddb.send(
          new GetCommand({ TableName: table, Key: { pk: checkpointPk(runId), sk: CHECKPOINT_SK } }),
        )
      ).Item as RunCheckpoint | undefined;
      question = cp?.question;
      pending = cp?.pending;
    }
    return json(200, {
      run: healed(run, agent, now),
      transcript: (t.Items ?? []) as TranscriptEntry[],
      ...(question ? { question } : {}),
      ...(pending ? { pending } : {}),
    });
  }

  // POST .../answer — reply to a waiting run. `approved` crosses this wire ONLY as the
  // literal boolean from the button; anything else the client sends is dropped, so a
  // crafted request can approve nothing the owner didn't press (§4c).
  if (method === "POST" && action === "answer") {
    if (run.status !== "waiting") return json(409, { error: "This run isn't waiting for an answer." });
    const body = parseBody(event);
    const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 20_000) : "";
    if (!answer) return json(400, { error: "An answer is required." });
    const approved = body.approved === true;
    const resumed: RunRecord = { ...run, status: "running", message: undefined };
    await ddb.send(
      new PutCommand({ TableName: table, Item: { pk: agentPk(agent.id), sk: runSk(runId), ...resumed } }),
    );
    await invokeRunner(runner, {
      runId,
      agentId: agent.id,
      input: run.input,
      tableName: table,
      answer,
      ...(approved ? { approved: true } : {}),
    });
    return json(200, { run: resumed });
  }

  // POST .../stop — the kill switch, same honest semantics as the desktop's: the row is
  // marked stopped now, and the runner re-reads status before every further step.
  if (method === "POST" && action === "stop") {
    if (run.status !== "running") return json(200, { run: healed(run, agent, now) });
    const stopped: RunRecord = {
      ...run,
      status: "stopped",
      stopReason: "error",
      finishedAt: nowIso,
      message: "You stopped this run from your phone.",
    };
    await ddb.send(
      new PutCommand({ TableName: table, Item: { pk: agentPk(agent.id), sk: runSk(runId), ...stopped } }),
    );
    return json(200, { run: stopped });
  }

  return NOT_FOUND;
}

function parseBody(event: UrlEvent): Record<string, unknown> {
  try {
    const text = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
