// The agent-runner Lambda — one invocation per run (DESIGN §5).
//
// Load the agent's definition → check it may spend → call Bedrock → persist the
// transcript, the tokens and the cost. At P2 the loop gains tool calls and the
// ask_user suspend/resume checkpoint; the guardrail structure below is already shaped
// for that, which is why it's a loop rather than a single call.
//
// SAFETY INVARIANT (DESIGN §4): this function's execution role is the only AWS
// permission anywhere near an agent, and the agent never sees those credentials. The
// model can only produce TEXT here — it has no tools at P1, so there is nothing it can
// reach even if the prompt is hostile. Tool output will be data, never instructions.
//
// GUARDRAILS ARE MECHANISMS (DESIGN §7): the loop asks `checkContinue` before every
// model call, and the answer is absolute. A run that trips a limit stops cleanly and
// records WHICH limit, so the user always learns why rather than guessing.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  AGENTS_PK,
  agentPk,
  agentSk,
  checkContinue,
  checkStart,
  capCostFor,
  costFor,
  inferenceProfileFor,
  monthKeyOf,
  remainingOutputBudget,
  PROVEN_SK,
  provenPk,
  runSk,
  spendPk,
  spendSk,
  transcriptPk,
  transcriptSk,
  type AgentDef,
  type RunRecord,
  type RunnerEvent,
  type StopReason,
  type TokenUsage,
} from "@crewpoppy/shared";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const bedrock = new BedrockRuntimeClient({ region: REGION });

/** A single model response, cropped to what we care about. */
interface ModelReply {
  text: string;
  usage: TokenUsage;
}

/**
 * Call Claude (or any Messages-API model) through the REGIONAL INFERENCE PROFILE.
 *
 * 🪤 The profile id is required: a bare foundation-model id fails with "on-demand
 * throughput isn't supported" (DESIGN §2c — this cost a live test).
 */
async function callModel(
  modelId: string,
  system: string,
  input: string,
  maxOutputTokens: number,
): Promise<ModelReply> {
  const out = await bedrock.send(
    new InvokeModelCommand({
      modelId: inferenceProfileFor(modelId, REGION),
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: maxOutputTokens,
        system,
        messages: [{ role: "user", content: input }],
      }),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(out.body)) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (body.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
  return {
    text,
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    },
  };
}

/** The persona preamble in front of the owner's brief (DESIGN §3). */
function systemPrompt(agent: AgentDef): string {
  return [
    `You are ${agent.name}, ${agent.role}.`,
    agent.instructions,
    // Disclosure guardrail (DESIGN §3): personas are encouraged, claiming humanity is not.
    "You are an AI assistant. Never claim to be human, and never deny being an AI if asked.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function loadAgent(table: string, agentId: string): Promise<AgentDef | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: table, Key: { pk: AGENTS_PK, sk: agentSk(agentId) } }),
  );
  return (r.Item as AgentDef | undefined) ?? null;
}

/** What this agent has already spent this calendar month. */
async function monthSpend(table: string, agentId: string, monthKey: string): Promise<number> {
  const r = await ddb.send(
    new GetCommand({ TableName: table, Key: { pk: spendPk(agentId), sk: spendSk(monthKey) } }),
  );
  return Number((r.Item as { usd?: number } | undefined)?.usd ?? 0);
}

/**
 * Add this run's cost to the month's counter with an atomic ADD — never a
 * read-modify-write, which would lose spend under concurrent runs and quietly break the
 * cap that makes the whole product safe to hand a credit card to.
 */
async function addSpend(table: string, agentId: string, monthKey: string, usd: number): Promise<void> {
  if (!usd) return;
  await ddb.send(
    new UpdateCommand({
      TableName: table,
      Key: { pk: spendPk(agentId), sk: spendSk(monthKey) },
      UpdateExpression: "ADD usd :u",
      ExpressionAttributeValues: { ":u": usd },
    }),
  );
}

async function writeTranscript(
  table: string,
  runId: string,
  seq: number,
  role: "user" | "assistant" | "system",
  text: string,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: table,
      // Deterministic key: re-running the same seq overwrites rather than duplicating.
      Item: { pk: transcriptPk(runId), sk: transcriptSk(seq), seq, role, text },
    }),
  );
}

async function saveRun(table: string, run: RunRecord): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: { pk: agentPk(run.agentId), sk: runSk(run.runId), ...run },
    }),
  );
}

export async function handler(event: RunnerEvent): Promise<{ ok: boolean; status: string }> {
  const table = event.tableName;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const monthKey = monthKeyOf(startedAt);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let iterations = 0;
  let stopReason: StopReason = "completed";
  let output: string | undefined;
  let message: string | undefined;

  const agent = await loadAgent(table, event.agentId);
  if (!agent) {
    await saveRun(table, {
      runId: event.runId,
      agentId: event.agentId,
      status: "failed",
      stopReason: "error",
      input: event.input,
      cost: { usage },
      iterations: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      message: "This agent no longer exists.",
      modelId: "",
    });
    return { ok: false, status: "failed" };
  }

  const finish = async (status: RunRecord["status"]) => {
    const cost = costFor(agent.modelId, usage);
    // Charge the CAP-accounting figure, not the display figure. A model with no
    // published rate must still count against the monthly ceiling, or the cap silently
    // stops being a cap (measured: Claude runs accumulated $0 and the limit could never
    // fire). Over-estimating is the safe direction.
    await addSpend(table, agent.id, monthKey, capCostFor(agent.modelId, usage));
    await saveRun(table, {
      runId: event.runId,
      agentId: agent.id,
      status,
      stopReason,
      input: event.input,
      output,
      cost,
      iterations,
      startedAt,
      finishedAt: new Date().toISOString(),
      message,
      modelId: agent.modelId,
    });
  };

  try {
    // Refuse to START if the agent is already at its monthly ceiling (DESIGN §7).
    const spentBefore = await monthSpend(table, agent.id, monthKey);
    const start = checkStart(agent.caps, spentBefore);
    if (!start.ok) {
      stopReason = start.reason ?? "monthly_spend_cap";
      message = start.message;
      await finish("stopped");
      return { ok: false, status: "stopped" };
    }

    await writeTranscript(table, event.runId, 0, "user", event.input);

    // The loop. At P1 the model has no tools, so it answers and we're done — but the
    // guardrail checks sit exactly where P2's tool round-trips will slot in.
    for (;;) {
      // The kill switch (DESIGN §7): the user may have stopped this run since the last
      // step. Re-read the record rather than trusting anything cached in this process.
      const current = await ddb.send(
        new GetCommand({ TableName: table, Key: { pk: agentPk(agent.id), sk: runSk(event.runId) } }),
      );
      if ((current.Item as RunRecord | undefined)?.status === "stopped") {
        return { ok: true, status: "stopped" }; // the record already says why
      }

      const verdict = checkContinue(agent.caps, {
        iterations,
        usage,
        elapsedMs: Date.now() - startMs,
        monthSpendUsd: spentBefore + capCostFor(agent.modelId, usage),
      });
      if (!verdict.ok) {
        stopReason = verdict.reason ?? "error";
        message = verdict.message;
        await finish("stopped");
        return { ok: true, status: "stopped" };
      }

      const budget = remainingOutputBudget(agent.caps, usage, 4096);
      const reply = await callModel(agent.modelId, systemPrompt(agent), event.input, budget);
      iterations += 1;
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
      output = reply.text;
      await writeTranscript(table, event.runId, iterations, "assistant", reply.text);

      // P1 has no tools, so one good answer completes the run.
      break;
    }

    // Ground truth for the model list: this model demonstrably works in this account.
    // Best-effort — a failure to record it must never fail an otherwise good run.
    try {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: { pk: provenPk(agent.modelId), sk: PROVEN_SK, modelId: agent.modelId, at: new Date().toISOString() },
        }),
      );
    } catch {
      /* the status field remains the fallback */
    }

    await finish("succeeded");
    return { ok: true, status: "succeeded" };
  } catch (e) {
    stopReason = "error";
    const raw = (e as Error)?.message ?? String(e);
    // One calm sentence, with the specific case the user can actually act on.
    message = /aws-marketplace/i.test(raw)
      ? "Your AWS account is still applying the permissions CrewPoppy just set up. This usually clears within a minute — try running again shortly."
      : /use case details have not been submitted/i.test(raw)
      ? "This model needs the one-time Anthropic form for your AWS account before it can run. Open CrewPoppy's model list to finish that step."
      : `The run couldn't finish: ${raw.slice(0, 200)}`;
    await finish("failed");
    return { ok: false, status: "failed" };
  }
}
