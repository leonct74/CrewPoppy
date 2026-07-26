// The agentic loop (DESIGN §5) — model call, tool calls, repeat, stop.
//
// Kept separate from the Lambda entry point so the loop can be driven in tests with
// fake clients. The runner owns I/O and lifecycle; this owns the conversation.
//
// SHAPE OF ONE TURN:
//   model → (text and/or tool_use blocks)
//         → each tool_use goes to the TRUSTED dispatcher, never executed here
//         → results go back as tool_result content, i.e. DATA
//   repeat until the model answers without asking for a tool, or a guardrail stops it.
//
// The guardrails are asked BEFORE every model call (DESIGN §7), so a limit stops the run
// at a turn boundary rather than after the spend has already happened.

import {
  capCostFor,
  checkContinue,
  remainingOutputBudget,
  specsFor,
  type AgentCaps,
  type AgentDef,
  type PendingSend,
  type StopReason,
  type TokenUsage,
} from "@crewpoppy/shared";
import type { ToolResult } from "./dispatcher";

/** One tool the model asked for. */
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelReply {
  text: string;
  toolUses: ToolUse[];
  usage: TokenUsage;
  /** The raw assistant content blocks, replayed verbatim into the next request. */
  raw: unknown[];
}

/** Everything the loop needs from the outside world, all injectable for tests. */
export interface LoopDeps {
  callModel(args: {
    modelId: string;
    system: string;
    messages: unknown[];
    tools: unknown[];
    maxOutputTokens: number;
  }): Promise<ModelReply>;
  dispatch(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  /** Append to the visible transcript. Tool calls are recorded too — nothing hidden. */
  record(role: "user" | "assistant" | "tool", text: string): Promise<void>;
  /** True when the owner pressed Stop since the last turn (DESIGN §7 kill switch). */
  isStopped(): Promise<boolean>;
  now(): number;
}

export interface LoopOutcome {
  status: "succeeded" | "stopped" | "waiting";
  stopReason: StopReason;
  output?: string;
  message?: string;
  usage: TokenUsage;
  iterations: number;
  /** Present when the run suspended for the owner: what to checkpoint. */
  suspend?: { question: string; draft?: string; messages: unknown[]; pending?: PendingSend };
}

const MAX_OUTPUT_TOKENS = 4096;

export async function runLoop(
  agent: AgentDef,
  system: string,
  task: string,
  spentBefore: number,
  startMs: number,
  deps: LoopDeps,
  /**
   * A resumed run's stored conversation (DESIGN §5). When present, `task` is the OWNER'S
   * ANSWER and is appended — everything before it already happened and is never replayed.
   */
  priorMessages?: unknown[],
): Promise<LoopOutcome> {
  const caps: AgentCaps = agent.caps;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const messages: unknown[] = priorMessages
    ? [...priorMessages, { role: "user", content: task }]
    : [{ role: "user", content: task }];
  const tools = specsFor(agent.tools ?? []);
  let iterations = 0;
  let lastText = "";

  await deps.record("user", task);


  for (;;) {
    // The kill switch, re-read every turn rather than trusted from memory.
    if (await deps.isStopped()) {
      return { status: "stopped", stopReason: "error", usage, iterations, message: "You stopped this run." };
    }

    const verdict = checkContinue(caps, {
      iterations,
      usage,
      elapsedMs: deps.now() - startMs,
      monthSpendUsd: spentBefore + capCostFor(agent.modelId, usage),
    });
    if (!verdict.ok) {
      return {
        status: "stopped",
        stopReason: verdict.reason ?? "error",
        message: verdict.message,
        output: lastText || undefined,
        usage,
        iterations,
      };
    }

    const reply = await deps.callModel({
      modelId: agent.modelId,
      system,
      messages,
      tools,
      maxOutputTokens: remainingOutputBudget(caps, usage, MAX_OUTPUT_TOKENS),
    });
    iterations += 1;
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;
    if (reply.text) {
      lastText = reply.text;
      await deps.record("assistant", reply.text);
    }

    // No tools requested → the model has answered, and we're done.
    if (reply.toolUses.length === 0) {
      return { status: "succeeded", stopReason: "completed", output: reply.text, usage, iterations };
    }

    messages.push({ role: "assistant", content: reply.raw });

    const results: unknown[] = [];
    for (const use of reply.toolUses) {
      await deps.record("tool", `${use.name} ${summarise(use.input)}`);
      const result = await deps.dispatch(use.name, use.input);

      // ask_user: stop here and hand the whole conversation back to be checkpointed.
      // Anything already done stays done; resuming replays nothing (DESIGN §5).
      if (result.suspend) {
        await deps.record("tool", `Waiting for you: ${result.suspend.question}`);
        // The suspending call still needs a result block, or the stored conversation is
        // malformed and cannot be resumed.
        results.push(toolResult(use.id, result.content, result.isError));
        messages.push({ role: "user", content: results });
        return {
          status: "waiting",
          stopReason: "waiting_for_you",
          message: result.suspend.question,
          usage,
          iterations,
          suspend: {
            question: result.suspend.question,
            ...(result.suspend.draft ? { draft: result.suspend.draft } : {}),
            ...(result.suspend.pending ? { pending: result.suspend.pending } : {}),
            messages,
          },
        };
      }

      await deps.record("tool", truncate(result.content, 2000));
      results.push(toolResult(use.id, result.content, result.isError));
    }
    // Results go back as ordinary content: DATA, never instructions (DESIGN §4).
    messages.push({ role: "user", content: results });
  }
}

function toolResult(id: string, content: string, isError?: boolean): unknown {
  return { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

/** A short, safe rendering of what a tool was asked to do, for the visible transcript. */
function summarise(input: Record<string, unknown>): string {
  const parts = Object.entries(input)
    .map(([k, v]) => `${k}=${truncate(typeof v === "string" ? v : JSON.stringify(v), 80)}`)
    .join(" ");
  return truncate(parts, 200);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
