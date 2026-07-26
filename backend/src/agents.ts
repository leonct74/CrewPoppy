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
  AGENTS_PK,
  DEFAULT_CAPS,
  agentPk,
  agentSk,
  monthKeyOf,
  runSk,
  sanitiseCaps,
  spendPk,
  spendSk,
  transcriptPk,
  type AgentCaps,
  type AgentDef,
  type RunRecord,
  type TranscriptEntry,
} from "@crewpoppy/shared";

export interface AgentInput {
  name: string;
  role: string;
  instructions: string;
  modelId: string;
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

export async function deleteAgent(
  ddb: DynamoDBDocumentClient,
  table: string,
  id: string,
): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: AGENTS_PK, sk: agentSk(id) } }));
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
