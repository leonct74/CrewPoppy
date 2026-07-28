// The email-approval endpoint (DESIGN §15e) — the ONLY internet-facing thing CrewPoppy
// puts in an account, so it is deliberately its own Lambda with a MINIMAL role: it can
// read/update rows in the CrewPoppy table and invoke the runner. No Bedrock, no SES, no
// S3 — a stranger who finds the URL has found a door with almost nothing behind it.
//
// The contract, as the founder set it (2026-07-26):
//   - a UNIQUE address per request: /a/<runId>/<64-hex-token>
//   - the token is high-entropy, stored only as a SHA-256 HASH, and expires in 24 h —
//     the request itself keeps waiting in the desktop app after the link dies
//   - GET only RENDERS; POST approves. Mail scanners prefetch every link in an inbox,
//     and a GET that approved would mean scanners approving everything on arrival.
//   - SINGLE USE, enforced atomically: the first POST claims the link with a conditional
//     write; a second POST — retry, double-click, replay — finds it spent.
//   - every failure looks identical. Wrong token, expired, used, no such run: same page,
//     so probing the URL space teaches nothing.

import { createHash, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  AGENTS_PK,
  CHECKPOINT_SK,
  agentPk,
  agentSk,
  checkpointPk,
  runSk,
  type AgentDef,
  type RunCheckpoint,
  type RunRecord,
} from "@crewpoppy/shared";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const lambda = new LambdaClient({ region: REGION });

/** The Function URL event shape — only the fields this handler actually reads. */
export interface UrlEvent {
  rawPath?: string;
  requestContext?: { http?: { method?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function html(status: number, inner: string) {
  return {
    statusCode: status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>CrewPoppy</title><style>
      body{margin:0;padding:24px;background:#171512;color:#efe9df;font:15px/1.55 -apple-system,system-ui,sans-serif}
      .card{max-width:560px;margin:0 auto;background:#211e1a;border:1px solid #3a352e;border-radius:12px;padding:20px}
      .muted{color:#9b937f;font-size:13px} pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#171512;border:1px solid #3a352e;border-radius:8px;padding:12px;font:13px/1.5 ui-monospace,monospace}
      .row{display:flex;gap:10px;margin-top:16px} button{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid #3a352e;cursor:pointer}
      .go{background:#8fd0c6;color:#10201d;border-color:transparent} .no{background:transparent;color:#e0b4ad}
      table{font-size:14px;border-collapse:collapse;margin:10px 0} td{padding:2px 10px 2px 0;vertical-align:top} td:first-child{color:#9b937f;font-size:12px;white-space:nowrap}
    </style></head><body><div class="card">${inner}</div></body></html>`,
  };
}

/** One page for every failure mode, so probing the URL space teaches nothing. */
const GONE = html(
  404,
  `<h2>This link isn't valid any more</h2>
   <p>It may have expired (links work for 24 hours), already been used, or been answered
   from the desktop app.</p>
   <p class="muted">If the request is still waiting, you'll find it in CrewPoppy on your computer.</p>`,
);

interface Loaded {
  cp: RunCheckpoint & { approvalHash?: string; approvalExpiresAt?: number; approvalUsedAt?: string };
  run: RunRecord;
  agent: AgentDef | undefined;
}

/** Everything that must be true before this link shows or does ANYTHING. */
async function load(table: string, runId: string, token: string): Promise<Loaded | null> {
  const cp = (
    await ddb.send(new GetCommand({ TableName: table, Key: { pk: checkpointPk(runId), sk: CHECKPOINT_SK } }))
  ).Item as Loaded["cp"] | undefined;
  if (!cp?.approvalHash || !cp.approvalExpiresAt || cp.approvalUsedAt) return null;
  if (Date.now() / 1000 > cp.approvalExpiresAt) return null;

  const given = createHash("sha256").update(token).digest();
  const stored = Buffer.from(cp.approvalHash, "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;

  const run = (
    await ddb.send(new GetCommand({ TableName: table, Key: { pk: agentPk(cp.agentId), sk: runSk(runId) } }))
  ).Item as RunRecord | undefined;
  if (!run || run.status !== "waiting") return null;

  const agent = (
    await ddb.send(new GetCommand({ TableName: table, Key: { pk: AGENTS_PK, sk: agentSk(cp.agentId) } }))
  ).Item as AgentDef | undefined;
  return { cp, run, agent };
}

export async function handler(event: UrlEvent) {
  const table = process.env.CREWPOPPY_TABLE || "";
  const runner = process.env.CREWPOPPY_RUNNER || "CrewPoppyRunner";
  const method = event.requestContext?.http?.method ?? "GET";
  const m = /^\/a\/([A-Za-z0-9-]{1,80})\/([a-f0-9]{64})$/.exec(event.rawPath ?? "");
  if (!m) return GONE;
  const [, runId, token] = m as unknown as [string, string, string];

  const loaded = await load(table, runId, token);
  if (!loaded) return GONE;
  const { cp, agent } = loaded;
  const name = agent?.name ?? "Your agent";

  if (method === "GET") {
    // Render only — a prefetching mail scanner lands here and changes NOTHING.
    const pending = cp.pending;
    const detail = pending
      ? `<table>
           <tr><td>To</td><td><strong>${esc(pending.to)}</strong></td></tr>
           <tr><td>Subject</td><td><strong>${esc(pending.subject)}</strong></td></tr>
           ${pending.attach ? `<tr><td>Attached</td><td>${esc(pending.attach)}</td></tr>` : ""}
         </table>
         <pre>${esc(pending.body)}</pre>
         <p class="muted">Approving sends exactly this — ${esc(name)} cannot change it afterwards.</p>`
      : cp.draft
        ? `<pre>${esc(cp.draft)}</pre>`
        : "";
    return html(
      200,
      `<h2>${esc(name)} is waiting for you</h2>
       <p>${esc(cp.question)}</p>
       ${detail}
       <form method="POST"><div class="row">
         <button class="go" name="action" value="approve">${pending ? "Send it" : "Approve"}</button>
         <button class="no" name="action" value="deny">${pending ? "Don't send" : "Deny"}</button>
       </div></form>
       <p class="muted">This link works once and expires 24 hours after it was sent. To reply
       with changes instead, open CrewPoppy on your computer.</p>`,
    );
  }

  if (method !== "POST") return GONE;
  const bodyText = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  const action = new URLSearchParams(bodyText).get("action");
  if (action !== "approve" && action !== "deny") return GONE;

  // SINGLE USE, atomically: the first POST claims the link; every later one fails here.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: checkpointPk(runId), sk: CHECKPOINT_SK },
        UpdateExpression: "SET approvalUsedAt = :t",
        ConditionExpression: "attribute_not_exists(approvalUsedAt)",
        ExpressionAttributeValues: { ":t": new Date().toISOString() },
      }),
    );
  } catch {
    return GONE;
  }

  // Same resume path as the desktop's Approve button — the runner sends the STORED copy.
  const approved = action === "approve";
  const resumed: RunRecord = { ...loaded.run, status: "running", message: undefined };
  await ddb.send(
    new PutCommand({ TableName: table, Item: { pk: agentPk(cp.agentId), sk: runSk(runId), ...resumed } }),
  );
  await lambda.send(
    new InvokeCommand({
      FunctionName: runner,
      InvocationType: "Event",
      Payload: Buffer.from(
        JSON.stringify({
          runId,
          agentId: cp.agentId,
          input: loaded.run.input,
          tableName: table,
          answer: approved
            ? "Approved from the email link — send it exactly as written."
            : "Denied from the email link — do not do that. Stop and explain why you asked.",
          ...(approved ? { approved: true } : {}),
        }),
      ),
    }),
  );

  return html(
    200,
    approved
      ? `<h2>Done — ${esc(name)} is carrying on</h2><p>You approved it. The result will be in CrewPoppy on your computer.</p>`
      : `<h2>Stopped — ${esc(name)} won't do it</h2><p>You said no. ${esc(name)} will explain itself in CrewPoppy on your computer.</p>`,
  );
}
