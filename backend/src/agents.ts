// Agent definitions and runs — the control plane the dashboard talks to.
//
// An agent is stored DATA, not code (DESIGN §3): create is a PutItem, and a crew of a
// hundred idle agents costs nothing until one runs. Everything takes its clients by
// injection so the logic is unit-testable without touching AWS.
//
// The runner Lambda does the actual thinking (DESIGN §5). The sidecar only writes the
// definition, starts the run, and reads back what happened — it never calls Bedrock, so
// a long run isn't tied to the desktop app being open.

import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  AGENTS_PK,
  CHECKPOINT_SK,
  CONFIG_PK,
  MAILBOX_SK_PREFIX,
  DEFAULT_CAPS,
  agentPk,
  agentSk,
  checkpointPk,
  isEmailAddress,
  isSafeRelativePath,
  isToolName,
  memoryPk,
  monthKeyOf,
  neverReportedBack,
  newestFirst,
  nextRunAt,
  normaliseEmail,
  runSk,
  sanitiseSchedule,
  sanitiseCaps,
  spendPk,
  spendSk,
  transcriptPk,
  workspaceKeyFor,
  workspacePrefixFor,
  type AgentCaps,
  type AgentDef,
  type PendingSend,
  type RunRecord,
  type TranscriptEntry,
} from "@crewpoppy/shared";

export interface AgentInput {
  name: string;
  role: string;
  instructions: string;
  modelId: string;
  tools?: unknown;
  /** An address the owner verified, "" to clear it, or absent to leave it as it was. */
  emailFrom?: unknown;
  /** May anyone start this agent by mail? Only literal true opens it (DESIGN §15g). */
  openInbox?: unknown;
  /** Where approvals are offered (DESIGN §15i): only the literal "phone" moves them. */
  approvalChannel?: unknown;
  /** A catalogue face id ("av-01"…"av-50"); "" clears it, absent leaves it alone. */
  avatar?: unknown;
  /** When it runs itself. null clears it; absent leaves it alone. */
  schedule?: unknown;
  caps?: Partial<AgentCaps>;
}

/** Everything the dashboard shows for one agent, including this month's spend. */
export interface AgentSummary extends AgentDef {
  monthSpendUsd: number;
  /** Computed here, by the ticker's own code, so the card can't promise a different time. */
  nextRunAt?: string;
}

function requireText(value: unknown, field: string, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new Error(`${field} is required.`);
  return s.slice(0, max);
}

/**
 * Create or replace an agent. The id is supplied by the caller so a retried request
 * overwrites rather than duplicating (idempotency — CLAUDE.md gotcha #3).
 */
export async function saveAgent(
  ddb: DynamoDBDocumentClient,
  table: string,
  id: string,
  input: AgentInput,
  now: string,
): Promise<AgentDef> {
  const existing = await getAgent(ddb, table, id);
  const def: AgentDef = {
    id,
    name: requireText(input.name, "A name", 80),
    role: requireText(input.role, "A role", 120),
    instructions: requireText(input.instructions, "Instructions", 20_000),
    modelId: requireText(input.modelId, "A model", 200),
    // Only names from the fixed catalogue survive; anything else the client sends is
    // dropped rather than stored, so a bad request can't widen an agent's reach.
    tools: Array.isArray(input.tools) ? input.tools.filter(isToolName) : (existing?.tools ?? []),
    // "Does Emma have an email?" — an address the owner already verified, or nothing.
    // Anything else is dropped rather than stored: an unverified sender is a bounce
    // waiting to happen, and a malformed one is a header-injection attempt.
    ...(isEmailAddress(input.emailFrom)
      ? { emailFrom: normaliseEmail(input.emailFrom) }
      : input.emailFrom === null || input.emailFrom === ""
        ? {}
        : existing?.emailFrom
          ? { emailFrom: existing.emailFrom }
          : {}),
    // A face is an id into the app's own catalogue — nothing else is worth storing,
    // and a malformed one would just render as a broken face forever.
    ...(typeof input.avatar === "string" && /^av-\d{2}$/.test(input.avatar)
      ? { avatar: input.avatar }
      : input.avatar === "" || input.avatar === null
        ? {}
        : existing?.avatar
          ? { avatar: existing.avatar }
          : {}),
    // "Who may email this agent?" Only the literal boolean opens the door; anything
    // else the client sends closes it or leaves it as it was. Cleared below if the
    // agent ends up with no address — a door flag with no door confuses forever.
    ...(input.openInbox === true
      ? { openInbox: true }
      : input.openInbox === undefined && existing?.openInbox
        ? { openInbox: true }
        : {}),
    // Where approvals are offered (DESIGN §15i). Email is the default and is stored as
    // ABSENCE, so every agent that predates this field already means "email". Only the
    // literal "phone" is stored; anything else the client sends means email.
    ...(input.approvalChannel === "phone"
      ? { approvalChannel: "phone" as const }
      : input.approvalChannel === undefined && existing?.approvalChannel === "phone"
        ? { approvalChannel: "phone" as const }
        : {}),
    // Same rule as caps and tools: nothing the client sends is stored raw. A schedule
    // with no task, an hour of 99, or a timezone that doesn't exist becomes either a
    // safe value or no schedule at all (DESIGN §5b).
    ...(input.schedule === null || input.schedule === ""
      ? {}
      : input.schedule !== undefined
        ? (() => {
            const s = sanitiseSchedule(input.schedule);
            return s ? { schedule: s } : {};
          })()
        : existing?.schedule
          ? { schedule: existing.schedule }
          : {}),
    // Caps are never taken raw from the client: a missing or absurd value falls back to
    // the safe default, so an agent can't be created without limits (DESIGN §7).
    caps: sanitiseCaps(input.caps ?? {}, DEFAULT_CAPS),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (!def.emailFrom) delete def.openInbox;
  await ddb.send(new PutCommand({ TableName: table, Item: { pk: AGENTS_PK, sk: agentSk(id), ...def } }));
  return def;
}

export async function getAgent(
  ddb: DynamoDBDocumentClient,
  table: string,
  id: string,
): Promise<AgentDef | null> {
  const r = await ddb.send(new GetCommand({ TableName: table, Key: { pk: AGENTS_PK, sk: agentSk(id) } }));
  return (r.Item as AgentDef | undefined) ?? null;
}

/** This agent's spend for the given calendar month. */
export async function monthSpend(
  ddb: DynamoDBDocumentClient,
  table: string,
  agentId: string,
  monthKey: string,
): Promise<number> {
  const r = await ddb.send(
    new GetCommand({ TableName: table, Key: { pk: spendPk(agentId), sk: spendSk(monthKey) } }),
  );
  return Number((r.Item as { usd?: number } | undefined)?.usd ?? 0);
}

/** The whole crew, each with this month's spend so the list can show cap usage. */
export async function listAgents(
  ddb: DynamoDBDocumentClient,
  table: string,
  now: string,
): Promise<AgentSummary[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": AGENTS_PK },
    }),
  );
  const defs = (r.Items ?? []) as AgentDef[];
  const monthKey = monthKeyOf(now);
  const at = new Date(now);
  return Promise.all(
    defs.map(async (d) => ({
      ...d,
      monthSpendUsd: await monthSpend(ddb, table, d.id, monthKey),
      ...(d.schedule ? { nextRunAt: nextRunAt(d.schedule, at)?.toISOString() } : {}),
    })),
  );
}

export interface DeleteAgentOutcome {
  ok: boolean;
  /** Present when we refused: one plain sentence the UI can show as-is. */
  reason?: string;
  /** What actually went, so the UI can say it rather than claim it. */
  removed?: { runs: number; memories: number; files: number };
}

/** Every item in one partition, deleted one at a time (no BatchWriteItem grant needed). */
async function deletePartition(
  ddb: DynamoDBDocumentClient,
  table: string,
  pk: string,
): Promise<number> {
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
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return count;
}

/** Everything under one agent's workspace prefix. Already-gone bucket is success. */
async function deleteWorkspace(s3: S3Client, bucket: string, agentId: string): Promise<number> {
  const Prefix = workspacePrefixFor(agentId);
  let count = 0;
  try {
    for (;;) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length === 0) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      count += keys.length;
      if (!page.IsTruncated) break;
    }
  } catch (e) {
    // The bucket only exists once the stack finished; nothing written means nothing to remove.
    const name = (e as { name?: string })?.name ?? "";
    if (name !== "NoSuchBucket" && name !== "NotFound") throw e;
  }
  return count;
}

/**
 * Delete an agent's runs, transcripts and checkpoints — and nothing else (founder
 * request, 2026-07-28: "clean the chat history, it takes too much space").
 *
 * Deliberately narrower than deleting the agent: memory, files and the definition stay,
 * and so do the SPEND COUNTERS — clearing a chat must never reset a cost cap, or tidying
 * up would double an agent's monthly budget. A live run refuses, same as delete.
 */
export async function clearHistory(
  ddb: DynamoDBDocumentClient,
  table: string,
  id: string,
  now: number,
): Promise<DeleteAgentOutcome> {
  const agent = await getAgent(ddb, table, id);
  if (!agent) return { ok: true, removed: { runs: 0, memories: 0, files: 0 } };

  const runs = (await listRuns(ddb, table, id)).map((r) => withStaleness(r, agent.caps, now));
  const live = runs.find((r) => r.status === "running" || r.status === "waiting");
  if (live) {
    return {
      ok: false,
      reason:
        live.status === "waiting"
          ? `${agent.name} is waiting for your answer. Answer or stop that run first.`
          : `${agent.name} is working right now. Stop the run first.`,
    };
  }

  for (const r of runs) {
    await deletePartition(ddb, table, transcriptPk(r.runId));
    await ddb.send(
      new DeleteCommand({ TableName: table, Key: { pk: checkpointPk(r.runId), sk: CHECKPOINT_SK } }),
    );
  }
  const runCount = await deletePartition(ddb, table, agentPk(id));
  return { ok: true, removed: { runs: runCount, memories: 0, files: 0 } };
}

/**
 * Remove an agent and everything that was only ever its own (DESIGN §3b).
 *
 * "Delete" has to mean it. An agent's memory is the thing most likely to hold something
 * the owner would rather not keep — a customer's details it was told to remember, a draft
 * it was asked to hold — so removing the definition and leaving the memory behind would
 * be the worst of both: gone from the screen, still in the account. This deletes the runs,
 * their transcripts and checkpoints, the memory, the spend counters and the workspace
 * files, then the definition LAST, so a failure part-way leaves the agent visible and
 * retryable rather than turning its data into orphans nothing lists.
 *
 * A live run blocks it: deleting the definition underneath a running Lambda would leave a
 * run that can neither finish nor be found. Stop it first — and say so, rather than doing
 * something surprising.
 *
 * Idempotent: an agent that is already gone is a success, so a retried request is safe.
 */
export async function deleteAgent(
  ddb: DynamoDBDocumentClient,
  s3: S3Client,
  table: string,
  bucket: string,
  id: string,
  now: number,
): Promise<DeleteAgentOutcome> {
  const agent = await getAgent(ddb, table, id);
  if (!agent) return { ok: true, removed: { runs: 0, memories: 0, files: 0 } };

  // The history half is exactly clearHistory — including the live-run refusal.
  const hist = await clearHistory(ddb, table, id, now);
  if (!hist.ok) return { ...hist, reason: `${hist.reason} Then delete.` };
  const runCount = hist.removed!.runs;
  const memories = await deletePartition(ddb, table, memoryPk(id));
  await deletePartition(ddb, table, spendPk(id));
  const files = await deleteWorkspace(s3, bucket, id);

  await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: AGENTS_PK, sk: agentSk(id) } }));
  return { ok: true, removed: { runs: runCount, memories, files } };
}

/**
 * Start a run: write the record FIRST, then invoke the Lambda asynchronously.
 *
 * Order matters. Recording "running" before the invoke means a user who closes the app
 * immediately still finds the run on their return (AGENTS.md §5) — state lives in their
 * account, not in the UI. `Event` invocation means the run continues regardless of what
 * the desktop does.
 */
export async function startRun(
  ddb: DynamoDBDocumentClient,
  lambda: LambdaClient,
  table: string,
  functionName: string,
  agent: AgentDef,
  runId: string,
  input: string,
  now: string,
): Promise<RunRecord> {
  const task = requireText(input, "A task", 20_000);
  const record: RunRecord = {
    runId,
    agentId: agent.id,
    status: "running",
    input: task,
    cost: { usage: { inputTokens: 0, outputTokens: 0 } },
    iterations: 0,
    startedAt: now,
    modelId: agent.modelId,
  };
  await ddb.send(
    new PutCommand({ TableName: table, Item: { pk: agentPk(agent.id), sk: runSk(runId), ...record } }),
  );
  await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ runId, agentId: agent.id, input: task, tableName: table })),
    }),
  );
  return record;
}

/**
 * A run whose Lambda never reported back must not spin forever.
 *
 * The runner enforces its own wall-clock cap, so a run still "running" well past that
 * is not slow — it never got there: the function errored before writing, was the wrong
 * version, or was never invoked. Derived on read rather than written, so this heals
 * existing rows without a migration and without a background job.
 */
export function withStaleness(run: RunRecord, caps: AgentCaps | undefined, now: number): RunRecord {
  // The shared predicate, so the UI and the TICKER judge staleness identically — they
  // didn't once, and the difference cost a day (shared/guardrails.ts).
  if (!neverReportedBack(run, caps, now)) return run;
  return {
    ...run,
    status: "failed",
    stopReason: "error",
    message:
      "This run never reported back. That usually means CrewPoppy's engine in your AWS account is out of date — check for an update above, then try again.",
  };
}

/** Runs for one agent, newest first. */
export async function listRuns(
  ddb: DynamoDBDocumentClient,
  table: string,
  agentId: string,
): Promise<RunRecord[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": agentPk(agentId), ":sk": "run#" },
    }),
  );
  // Newest first BY THE CLOCK. 🪤 ScanIndexForward:false sorts by the SORT KEY, and a
  // run's key is `run#<uuid>` — random. It read as "newest first" everywhere and was
  // in fact arbitrary (founder spotted it in the phone's chat, 2026-07-31).
  return newestFirst((r.Items ?? []) as RunRecord[]);
}

export async function getRun(
  ddb: DynamoDBDocumentClient,
  table: string,
  agentId: string,
  runId: string,
): Promise<RunRecord | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: table, Key: { pk: agentPk(agentId), sk: runSk(runId) } }),
  );
  return (r.Item as RunRecord | undefined) ?? null;
}

/**
 * Answer a run that is waiting on `ask_user`, and let it carry on (DESIGN §5).
 *
 * The answer is passed to a FRESH runner invocation, which continues from the stored
 * checkpoint. Nothing that already happened is re-executed — the earlier tool calls are
 * inside the checkpoint as results, which is the whole point of checkpointing the
 * conversation rather than the intent.
 */
export async function answerRun(
  ddb: DynamoDBDocumentClient,
  lambda: LambdaClient,
  table: string,
  functionName: string,
  agentId: string,
  runId: string,
  answer: string,
  now: string,
  /**
   * True ONLY when the owner pressed Approve on the exact action shown. Never derived
   * from their words — "yes, but change the greeting" is a different message, and it has
   * to be proposed and approved on its own (DESIGN §4c).
   */
  approved?: boolean,
): Promise<RunRecord | null> {
  const run = await getRun(ddb, table, agentId, runId);
  if (!run) return null;
  // Only a waiting run can be answered. Anything else would either restart finished work
  // or race a run that is already going.
  if (run.status !== "waiting") return run;

  const text = requireText(answer, "An answer", 20_000);
  const resumed: RunRecord = { ...run, status: "running", message: undefined, startedAt: run.startedAt };
  await ddb.send(
    new PutCommand({ TableName: table, Item: { pk: agentPk(agentId), sk: runSk(runId), ...resumed } }),
  );
  await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(
        JSON.stringify({
          runId,
          agentId,
          input: run.input,
          tableName: table,
          answer: text,
          ...(approved ? { approved: true } : {}),
        }),
      ),
    }),
  );
  void now;
  return resumed;
}

/**
 * The kill switch (DESIGN §7). Marks the run stopped so the UI is truthful immediately
 * and the record shows who ended it.
 *
 * HONEST LIMIT: a model call already in flight isn't torn out of the network — but the
 * runner re-reads this status before every further step, so the loop cannot continue.
 * At P1 that means at most the current call finishes; from P2, where a loop can run many
 * steps and many tools, it stops the run dead.
 */
export async function stopRun(
  ddb: DynamoDBDocumentClient,
  table: string,
  agentId: string,
  runId: string,
  now: string,
): Promise<RunRecord | null> {
  const run = await getRun(ddb, table, agentId, runId);
  if (!run) return null;
  if (run.status !== "running") return run; // already finished — nothing to stop
  const stopped: RunRecord = {
    ...run,
    status: "stopped",
    stopReason: "error",
    finishedAt: now,
    message: "You stopped this run.",
  };
  await ddb.send(
    new PutCommand({ TableName: table, Item: { pk: agentPk(agentId), sk: runSk(runId), ...stopped } }),
  );
  return stopped;
}

/**
 * The action a waiting run proposed, read from its checkpoint.
 *
 * Read from the SAME row the runner will send from, so what the owner approves and what
 * goes out cannot drift apart (DESIGN §4c).
 */
export async function getPending(
  ddb: DynamoDBDocumentClient,
  table: string,
  runId: string,
): Promise<PendingSend | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: table, Key: { pk: checkpointPk(runId), sk: CHECKPOINT_SK } }),
  );
  return (r.Item as { pending?: PendingSend } | undefined)?.pending;
}

/** The MailPoppy mailboxes assigned to agents — what the editor's SELECT offers. */
export async function listAgentMailboxes(
  ddb: DynamoDBDocumentClient,
  table: string,
): Promise<string[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": CONFIG_PK, ":sk": MAILBOX_SK_PREFIX },
    }),
  );
  return ((r.Items ?? []) as { email?: string }[]).map((i) => i.email ?? "").filter(Boolean).sort();
}

// ---- the owner's window into an agent's workspace (DESIGN §3, 2026-07-28) ----------
// An agent that writes files nobody can open hasn't produced results, it has produced
// exhaust. These are the OWNER's reads — same bucket, same per-agent prefix rule as the
// dispatcher, enforced with the same shared predicate.

export interface WorkspaceFile {
  path: string;
  size: number;
  modified?: string;
}

/** Every file this agent has written. A bucket that doesn't exist yet is an empty list. */
export async function listFiles(
  s3: S3Client,
  bucket: string,
  agentId: string,
): Promise<WorkspaceFile[]> {
  const Prefix = workspacePrefixFor(agentId);
  const files: WorkspaceFile[] = [];
  let token: string | undefined;
  try {
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        const path = (o.Key ?? "").slice(Prefix.length);
        if (path) files.push({ path, size: o.Size ?? 0, modified: o.LastModified?.toISOString() });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name !== "NoSuchBucket" && name !== "NotFound") throw e;
  }
  return files;
}

/**
 * One file's content, or null when it doesn't exist. The path is validated with the SAME
 * rule the dispatcher applies to the model — the owner is trusted, but the URL a request
 * arrives on is a string like any other, and one traversal rule is better than two.
 */
export async function readFileContent(
  s3: S3Client,
  bucket: string,
  agentId: string,
  path: unknown,
): Promise<string | null> {
  if (!isSafeRelativePath(path)) return null;
  try {
    const r = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: workspaceKeyFor(agentId, path) }),
    );
    return (await r.Body?.transformToString()) ?? "";
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name === "NoSuchKey" || name === "NoSuchBucket" || name === "NotFound") return null;
    throw e;
  }
}

/**
 * The OWNER saves a file into the agent's workspace (founder request, 2026-07-28) —
 * the template story: put `invoice-template.md` in Emma's folder, tell her to follow it,
 * and she reads it with her own workspace_read. Text only, same limits and the same
 * traversal predicate as the agent's own writes: the owner is trusted, the string isn't.
 */
export async function putOwnerFile(
  s3: S3Client,
  bucket: string,
  agentId: string,
  path: unknown,
  content: unknown,
): Promise<{ ok: boolean; reason?: string }> {
  if (!isSafeRelativePath(path)) {
    return { ok: false, reason: "That file name isn't allowed. Use a plain name, no leading slash and no '..'." };
  }
  const text = typeof content === "string" ? content : "";
  if (!text.trim()) return { ok: false, reason: "The file is empty — paste its contents first." };
  if (Buffer.byteLength(text) > 500_000) {
    return { ok: false, reason: "That file is too large (limit 500 KB)." };
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: workspaceKeyFor(agentId, path),
      Body: text,
      ContentType: "text/plain; charset=utf-8",
    }),
  );
  return { ok: true };
}

/**
 * Delete ONE of an agent's files (founder, 2026-07-31: "the user needs to access the
 * agents' files so he can delete them and/or review").
 *
 * The owner's own tidy-up — an agent's folder accumulates drafts, and a file it wrote
 * once may be a customer's details it should not keep. Same traversal predicate as
 * every other path that reaches this bucket: the owner is trusted, the string is not.
 * Idempotent — a file already gone is a success, so a double-click is harmless.
 */
export async function deleteFile(
  s3: S3Client,
  bucket: string,
  agentId: string,
  path: unknown,
): Promise<{ ok: boolean; reason?: string }> {
  if (!isSafeRelativePath(path)) return { ok: false, reason: "That file name isn't allowed." };
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: workspaceKeyFor(agentId, path) }));
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name !== "NoSuchKey" && name !== "NoSuchBucket" && name !== "NotFound") throw e;
  }
  return { ok: true };
}

/**
 * A short-lived, pre-signed URL for ONE file — how a PDF (or any binary) leaves the
 * workspace. The owner's browser talks straight to their own bucket; nothing routes
 * through us, and the link dies in five minutes. Same traversal predicate as everywhere.
 */
export async function fileLink(
  s3: S3Client,
  bucket: string,
  agentId: string,
  path: unknown,
): Promise<string | null> {
  if (!isSafeRelativePath(path)) return null;
  // Strip anything that could break out of the quoted header value.
  const filename = path.split("/").pop()!.replace(/["\\\r\n;]/g, "");
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: workspaceKeyFor(agentId, path),
      // Download with the file's own name, whatever the browser decides to do with it.
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }),
    { expiresIn: 300 },
  );
}

/** The run's transcript, in order. */
export async function getTranscript(
  ddb: DynamoDBDocumentClient,
  table: string,
  runId: string,
): Promise<TranscriptEntry[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": transcriptPk(runId) },
    }),
  );
  return (r.Items ?? []) as TranscriptEntry[];
}
