// CrewPoppy backend sidecar — the HTTP surface the host proxies frontend calls to,
// plus the teardown hook. Spawned by AgentsPoppy with AGENTSPOPPY_BOOTSTRAP; listens on
// the injected loopback port (never a fixed one). See AGENTS.md §7, DESIGN.md §2.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { randomUUID } from "node:crypto";
import { readBootstrap, brokerCredentialsProvider } from "./boot";
import {
  deploy, getStatus, teardown, runnerFunctionName, tableName, workspaceBucketName,
} from "./stack";
import {
  answerRun, clearHistory, deleteAgent, deleteFile, fileLink, getAgent, getPending, getRun, getTranscript, listAgents,
  listAgentMailboxes, listFiles, listRuns, putOwnerFile, readFileContent, saveAgent, startRun,
  stopRun, withStaleness,
} from "./agents";
import { getOwnerEmail, isVerifiedSender, setOwnerEmail } from "./email";
import { getMobileStatus, pairMobile, revokeMobile } from "./mobile";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { consoleUrl, getCatalogue, getModelAccess } from "./bedrock";
import {
  COMING_CAPABILITIES, EMAIL_TOOLS, TOOL_GROUPS, TOOL_NAMES, TOOL_NOTES,
  describeSchedule, nextRunAt, sanitiseSchedule,
  CONFIG_PK, LAST_TICK_SK, TICK_MINUTES,
} from "@crewpoppy/shared";

const boot = readBootstrap();
const credentials = brokerCredentialsProvider(boot);
const region = boot.account.region;
const cfn = new CloudFormationClient({ region, credentials });
const s3 = new S3Client({ region, credentials });
const bedrock = new BedrockClient({ region, credentials });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region, credentials }));
const lambda = new LambdaClient({ region, credentials });
const ses = new SESv2Client({ region, credentials });
const cognito = new CognitoIdentityProviderClient({ region, credentials });
const ctx = { accountId: boot.account.accountId, connectionId: boot.connectionId };

/** Read a JSON request body. An empty or malformed body is an empty object, not a crash. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** One calm sentence for the UI — never a raw stack trace (AGENTS.md §9). */
function errorMessage(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && (parts.length === 0 || parts[0] === "health")) return json(res, 200, { ok: true });
    if (method === "GET" && parts[0] === "meta") {
      return json(res, 200, { account: boot.account, connectionId: boot.connectionId });
    }

    // The live deployment state, read from CloudFormation on every call. The frontend
    // holds no memory of a deploy; this is what it mounts against and polls.
    if (method === "GET" && parts[0] === "status" && parts.length === 1) {
      return json(res, 200, await getStatus(cfn, region));
    }

    // Can this account actually run Claude yet? Drives the one-time setup card. Read-only
    // and token-free — deliberately NOT a probe invocation (see bedrock.ts).
    if (method === "GET" && parts[0] === "model-access" && parts.length === 1) {
      return json(res, 200, { ...(await getModelAccess(bedrock)), consoleUrl: consoleUrl(region) });
    }

    // The curated model shortlist, each answered against this account: which are ready
    // now, which need the one-time provider form, what each is good at, relative cost.
    if (method === "GET" && parts[0] === "models" && parts.length === 1) {
      return json(res, 200, { models: await getCatalogue(bedrock, ddb, tableName), consoleUrl: consoleUrl(region) });
    }

    // The address agents email you at (DESIGN §4c). Read re-checks it against SES, so a
    // setting can't quietly rot into one that bounces.
    if (method === "GET" && parts[0] === "owner-email" && parts.length === 1) {
      return json(res, 200, await getOwnerEmail(ddb, ses, tableName));
    }
    if (method === "PUT" && parts[0] === "owner-email" && parts.length === 1) {
      const body = await readJson(req);
      return json(res, 200, await setOwnerEmail(ddb, ses, tableName, body.email));
    }
    // Is this address one AWS will actually send from? Used by the agent editor before
    // it lets you give an agent an address of its own.
    if (method === "GET" && parts[0] === "verify-sender" && parts.length === 1) {
      const address = url.searchParams.get("email") ?? "";
      return json(res, 200, { email: address, verified: await isVerifiedSender(ses, address) });
    }

    // What a schedule actually means, answered by the SAME code the ticker uses
    // (DESIGN §5b). The editor asks before saving, so "next run" is a fact rather than
    // the UI's own guess — the founder had no way to tell whether 20:40 meant 20:40 in
    // their own clock, and a second implementation in the frontend could have lied.
    if (method === "POST" && parts[0] === "schedule-preview" && parts.length === 1) {
      const body = await readJson(req);
      const schedule = sanitiseSchedule(body.schedule);
      if (!schedule) return json(res, 200, {});
      const next = nextRunAt(schedule, new Date());
      return json(res, 200, {
        schedule,
        description: describeSchedule(schedule),
        nextRunAt: next?.toISOString(),
      });
    }

    // Is the ticker alive? Reads the heartbeat the runner writes on EVERY tick, so the
    // UI can tell "AWS isn't waking CrewPoppy" apart from "it woke and nothing was due"
    // — two very different faults that looked identical for four rounds of debugging.
    if (method === "GET" && parts[0] === "ticker" && parts.length === 1) {
      const r = await ddb.send(
        new GetCommand({ TableName: tableName, Key: { pk: CONFIG_PK, sk: LAST_TICK_SK } }),
      );
      const beat = r.Item as
        | { at?: string; agents?: number; scheduled?: number; due?: number; started?: number }
        | undefined;
      const ageMs = beat?.at ? Date.now() - Date.parse(beat.at) : undefined;
      return json(res, 200, {
        ...beat,
        // Two ticks' grace before we call it: one missed beat is noise, not a fault.
        healthy: ageMs !== undefined && ageMs < 3 * TICK_MINUTES * 60_000,
        everRan: !!beat?.at,
      });
    }

    // The MailPoppy mailboxes assigned to agents — populates the editor's address SELECT.
    if (method === "GET" && parts[0] === "agent-mailboxes" && parts.length === 1) {
      return json(res, 200, { mailboxes: await listAgentMailboxes(ddb, tableName) });
    }

    // The tool catalogue, with the plain-language note shown beside each checkbox.
    if (method === "GET" && parts[0] === "tools" && parts.length === 1) {
      return json(res, 200, {
        tools: TOOL_NAMES.map((name) => ({ name, ...TOOL_NOTES[name] })),
        // Grouped the way an owner actually asks: "can it email? only me? other people?"
        groups: TOOL_GROUPS,
        needsEmail: EMAIL_TOOLS,
        // Shown greyed out, so the list is an honest account of what an agent can do —
        // not just a menu of what happens to be possible.
        coming: COMING_CAPABILITIES,
      });
    }

    // ---- the phone (DESIGN §15h M1) ----------------------------------------
    // Status is read live from the stack + pool on every call, like all deployment
    // state. Pairing MINTS the one phone login and returns the QR payload — the
    // password inside it is never stored and never appears in any later response.
    if (method === "GET" && parts[0] === "mobile" && parts.length === 1) {
      return json(res, 200, await getMobileStatus(cfn, cognito));
    }
    if (method === "POST" && parts[0] === "mobile" && parts[1] === "pair" && parts.length === 2) {
      const out = await pairMobile(cfn, cognito, region);
      if (!out.ok) return json(res, 409, { error: out.reason });
      return json(res, 200, out);
    }
    if (method === "POST" && parts[0] === "mobile" && parts[1] === "revoke" && parts.length === 2) {
      return json(res, 200, await revokeMobile(cfn, cognito));
    }

    // Start (or update) the deploy. Returns as soon as AWS accepts it — the work
    // carries on in the background whatever the UI does.
    if (method === "POST" && parts[0] === "deploy" && parts.length === 1) {
      return json(res, 200, await deploy(cfn, s3, ctx, region));
    }

    // The teardown hook the host POSTs at the start of teardown. MUST be idempotent.
    if (method === "POST" && parts[0] === "teardown" && parts.length === 1) {
      return json(res, 200, { ok: true, ...(await teardown(cfn, s3, ctx.accountId, region)) });
    }

    // ---- agents (P1) -------------------------------------------------------
    if (parts[0] === "agents") {
      const now = new Date().toISOString();

      if (method === "GET" && parts.length === 1) {
        return json(res, 200, { agents: await listAgents(ddb, tableName, now) });
      }
      // Create/replace. The id comes from us, so a retried request overwrites.
      if (method === "POST" && parts.length === 1) {
        const body = await readJson(req);
        const id = typeof body.id === "string" && body.id ? body.id : randomUUID();
        return json(res, 200, await saveAgent(ddb, tableName, id, body as never, now));
      }
      // Delete an agent and everything that was only ever its own. A live run is a
      // refusal (409), not a failure — the UI shows the sentence and offers Stop.
      if (method === "DELETE" && parts.length === 2) {
        const outcome = await deleteAgent(
          ddb, s3, tableName, workspaceBucketName(ctx.accountId, region), parts[1]!, Date.now(),
        );
        if (!outcome.ok) return json(res, 409, { error: outcome.reason });
        return json(res, 200, outcome);
      }
      // The agent's files — the owner's window into the workspace. No path = the list;
      // ?path= = one file's content. The path rides in the QUERY because file names may
      // contain slashes, and the route splitter must not be in the business of guessing.
      if (method === "GET" && parts.length === 3 && parts[2] === "files") {
        const bucket = workspaceBucketName(ctx.accountId, region);
        const path = url.searchParams.get("path");
        if (path === null) {
          return json(res, 200, { files: await listFiles(s3, bucket, parts[1]!) });
        }
        const content = await readFileContent(s3, bucket, parts[1]!, path);
        if (content === null) return json(res, 404, { error: "That file doesn't exist any more." });
        return json(res, 200, { path, content });
      }
      // Wipe the conversation history: runs, transcripts, checkpoints. Memory, files,
      // the definition and the SPEND counters all stay — tidying up never resets a cap.
      if (method === "DELETE" && parts.length === 3 && parts[2] === "history") {
        const out = await clearHistory(ddb, tableName, parts[1]!, Date.now());
        if (!out.ok) return json(res, 409, { error: out.reason });
        return json(res, 200, out);
      }
      // The owner saves a file INTO the agent's workspace — templates, reference docs.
      if (method === "PUT" && parts.length === 3 && parts[2] === "files") {
        const body = await readJson(req);
        const out = await putOwnerFile(
          s3, workspaceBucketName(ctx.accountId, region), parts[1]!, body.path, body.content,
        );
        if (!out.ok) return json(res, 400, { error: out.reason });
        return json(res, 200, { ok: true });
      }
      // Remove one file from the agent's folder — the owner's tidy-up.
      if (method === "DELETE" && parts.length === 3 && parts[2] === "files") {
        const out = await deleteFile(
          s3, workspaceBucketName(ctx.accountId, region), parts[1]!, url.searchParams.get("path") ?? "",
        );
        if (!out.ok) return json(res, 400, { error: out.reason });
        return json(res, 200, { ok: true });
      }
      // A five-minute signed link to one file — how a PDF reaches the owner's browser.
      if (method === "GET" && parts.length === 3 && parts[2] === "file-link") {
        const link = await fileLink(
          s3, workspaceBucketName(ctx.accountId, region), parts[1]!, url.searchParams.get("path") ?? "",
        );
        if (!link) return json(res, 404, { error: "That file doesn't exist any more." });
        return json(res, 200, { url: link });
      }
      // Start a run. Returns immediately — the Lambda carries on in their account.
      if (method === "POST" && parts.length === 3 && parts[2] === "runs") {
        const agent = await getAgent(ddb, tableName, parts[1]!);
        if (!agent) return json(res, 404, { error: "That agent no longer exists." });
        const body = await readJson(req);
        const runId = typeof body.runId === "string" && body.runId ? body.runId : randomUUID();
        const run = await startRun(
          ddb, lambda, tableName, runnerFunctionName, agent, runId, String(body.input ?? ""), now,
        );
        return json(res, 200, run);
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "runs") {
        const agent = await getAgent(ddb, tableName, parts[1]!);
        const runs = (await listRuns(ddb, tableName, parts[1]!)).map((r) =>
          withStaleness(r, agent?.caps, Date.now()),
        );
        return json(res, 200, { runs });
      }
      // Answer a run waiting on ask_user, and let it continue (DESIGN §5). `approved` is
      // the Approve BUTTON — never inferred from the words, so a proposed email is sent
      // only when the owner said yes to that exact message (DESIGN §4c).
      if (method === "POST" && parts.length === 5 && parts[2] === "runs" && parts[4] === "answer") {
        const body = await readJson(req);
        const answered = await answerRun(
          ddb, lambda, tableName, runnerFunctionName, parts[1]!, parts[3]!, String(body.answer ?? ""), now,
          body.approved === true,
        );
        if (!answered) return json(res, 404, { error: "That run no longer exists." });
        return json(res, 200, answered);
      }
      // The kill switch (DESIGN §7).
      if (method === "POST" && parts.length === 5 && parts[2] === "runs" && parts[4] === "stop") {
        const stopped = await stopRun(ddb, tableName, parts[1]!, parts[3]!, now);
        if (!stopped) return json(res, 404, { error: "That run no longer exists." });
        return json(res, 200, stopped);
      }
      // One run plus its transcript — what the run view polls. A waiting run also carries
      // the action awaiting approval, so the UI shows the real recipient and the real
      // words rather than the agent's account of them.
      if (method === "GET" && parts.length === 4 && parts[2] === "runs") {
        const run = await getRun(ddb, tableName, parts[1]!, parts[3]!);
        if (!run) return json(res, 404, { error: "That run no longer exists." });
        const agent = await getAgent(ddb, tableName, parts[1]!);
        const pending = run.status === "waiting" ? await getPending(ddb, tableName, parts[3]!) : undefined;
        return json(res, 200, {
          run: withStaleness(run, agent?.caps, Date.now()),
          transcript: await getTranscript(ddb, tableName, parts[3]!),
          ...(pending ? { pending } : {}),
        });
      }
    }

    return json(res, 404, { error: `No route for ${method} /${parts.join("/")}` });
  } catch (e) {
    return json(res, 500, { error: errorMessage(e) });
  }
});

const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[crewpoppy] backend listening on 127.0.0.1:${actual} (region ${region})`);
});
