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
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  AGENTS_PK,
  CHECKPOINT_SK,
  DEFAULT_CAPS,
  agentPk,
  agentSk,
  checkpointPk,
  isEmailAddress,
  isToolName,
  memoryPk,
  monthKeyOf,
  normaliseEmail,
  runSk,
  sanitiseSchedule,
  sanitiseCaps,
  spendPk,
  spendSk,
  transcriptPk,
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
  /** When it runs itself. null clears it; absent leaves it alone. */
  schedule?: unknown;
  caps?: Partial<AgentCaps>;
}

/** Everything the dashboard shows for one agent, including this month's spend. */
export interface AgentSummary extends AgentDef {
  monthSpendUsd: number;
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
  return Promise.all(
    defs.map(async (d) => ({ ...d, monthSpendUsd: await monthSpend(ddb, table, d.id, monthKey) })),
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

  const runs = (await listRuns(ddb, table, id)).map((r) => withStaleness(r, agent.caps, now));
  const live = runs.find((r) => r.status === "running" || r.status === "waiting");
  if (live) {
    return {
      ok: false,
      reason:
        live.status === "waiting"
          ? `${agent.name} is waiting for your answer. Answer or stop that run first, then delete.`
          : `${agent.name} is working right now. Stop the run first, then delete.`,
    };
  }

  // Transcripts and checkpoints hang off the RUN id, not the agent, so they need the run
  // list — which is why this happens before the runs themselves go.
  for (const r of runs) {
    await deletePartition(ddb, table, transcriptPk(r.runId));
    await ddb.send(
      new DeleteCommand({ TableName: table, Key: { pk: checkpointPk(r.runId), sk: CHECKPOINT_SK } }),
    );
  }
  const runCount = await deletePartition(ddb, table, agentPk(id));
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
  if (run.status !== "running") return run;
  const budgetMs = (caps?.maxWallClockMs ?? 120_000) + 90_000; // + Lambda cold start & margin
  const age = now - Date.parse(run.startedAt);
  if (!Number.isFinite(age) || age < budgetMs) return run;
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
      ScanIndexForward: false,
    }),
  );
  return (r.Items ?? []) as RunRecord[];
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
