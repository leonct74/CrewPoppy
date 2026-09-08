// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The agentic loop (DESIGN.md §5, ported in §18 G3c): model call, tool calls, repeat, stop.
 *
 * SHAPE OF ONE TURN:
 *   model → words and/or function calls
 *         → each call goes to the TRUSTED dispatcher, never executed here
 *         → the results go back as function responses, i.e. DATA
 *   repeat until the model answers without asking for a tool, or a guardrail stops it.
 *
 * The guardrails are asked BEFORE every model call (§7), so a limit stops the run at a turn
 * boundary rather than after the spend has happened. The conversation is kept in the model's own
 * shape and replayed verbatim; it leaves this file only when a run pauses for the user.
 */
import type { ToolResult } from "./dispatcher";
import type { ConverseReply, FunctionDeclaration } from "./vertex";

/** Per run: the most turns, and the most wall-clock (§7: "max iterations, max tokens, max wall-clock"). */
export const MAX_ITERATIONS = 8;
export const MAX_RUN_MS = 4 * 60 * 1000;
const STEP_CHARS = 1_500;
/** The function response of an ask_user call while the user has not answered; replaced on resume. */
export const PENDING_ANSWER = "PENDING — the user has not answered yet.";

export interface Step {
  at: string;
  kind: "model" | "tool" | "result" | "asked" | "stopped";
  text: string;
}

export interface Usage {
  calls: number;
  promptTokens: number;
  outputTokens: number;
}

export interface LoopDeps {
  callModel(req: { contents: unknown[]; tools: FunctionDeclaration[]; maxOutputTokens: number }): Promise<ConverseReply>;
  dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Asked before every model call; a reason stops the run there, before the spend. */
  mayContinue(usage: Usage, iterations: number, elapsedMs: number): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Told after every model call — the counters are the runner's, written at once. */
  recordCall(promptTokens: number, outputTokens: number): Promise<void>;
  now(): string;
}

export interface LoopOutcome {
  status: "succeeded" | "stopped" | "waiting";
  /** The last words the model wrote — the answer when it succeeded; whatever it had when it stopped. */
  output: string;
  /** Why it stopped, in the user's words. */
  reason?: string;
  usage: Usage;
  iterations: number;
  steps: Step[];
  /** The conversation so far, in the model's own shape — kept only while the run waits for the user. */
  contents: unknown[];
  question?: { question: string; draft?: string };
  /** The reads the tools made — receipts and bytes — for the run's tally. */
  reads: Array<{ receipt?: string; count: number; bytes: number }>;
  /** The tools the model used, in order of first use. */
  toolsUsed: string[];
}

export const CUT_SHORT = "The answer was cut off — it was longer than this agent can write in one go. Ask for a shorter version, or split the job. What you can see is only part of the answer; don't rely on it as complete.";

export async function runLoop(args: { task?: string; tools: FunctionDeclaration[]; maxOutputTokens: number; priorContents?: unknown[] }, deps: LoopDeps): Promise<LoopOutcome> {
  const contents: unknown[] = [...(args.priorContents ?? [])];
  if (args.task !== undefined) contents.push({ role: "user", parts: [{ text: args.task }] });
  const usage: Usage = { calls: 0, promptTokens: 0, outputTokens: 0 };
  const steps: Step[] = [];
  const reads: LoopOutcome["reads"] = [];
  const toolsUsed: string[] = [];
  const started = Date.parse(deps.now());
  let iterations = 0;
  let lastText = "";
  const record = (kind: Step["kind"], text: string): void => {
    steps.push({ at: deps.now(), kind, text: truncate(text, STEP_CHARS) });
  };
  const done = (status: LoopOutcome["status"], extra: Partial<LoopOutcome> = {}): LoopOutcome => ({ status, output: lastText, usage, iterations, steps, contents, reads, toolsUsed, ...extra });

  for (;;) {
    const verdict = await deps.mayContinue(usage, iterations, Date.parse(deps.now()) - started);
    if (!verdict.ok) {
      record("stopped", verdict.reason);
      return done("stopped", { reason: verdict.reason });
    }

    const reply = await deps.callModel({ contents, tools: args.tools, maxOutputTokens: args.maxOutputTokens });
    iterations += 1;
    usage.calls += 1;
    usage.promptTokens += reply.promptTokens;
    usage.outputTokens += reply.outputTokens;
    await deps.recordCall(reply.promptTokens, reply.outputTokens);
    if (reply.text) {
      lastText = reply.text;
      record("model", reply.text);
    }
    contents.push({ role: "model", parts: reply.parts });

    // Ran out of room mid-answer: stop and SAY SO — a tool call cut in half is not a request to send.
    if (reply.truncated) {
      record("stopped", CUT_SHORT);
      return done("stopped", { reason: CUT_SHORT });
    }
    // No tools asked for → the model has answered.
    if (reply.calls.length === 0) return done("succeeded");

    const responses: unknown[] = [];
    let question: LoopOutcome["question"] | undefined;
    for (const call of reply.calls) {
      if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
      if (question) {
        // The run is pausing on an earlier call of this turn; the rest are not done, and say so.
        responses.push(functionResponse(call.name, "Not done — the run paused for the user's answer first.", true));
        continue;
      }
      record("tool", `${call.name} ${summarise(call.args)}`.trim());
      const result = await deps.dispatch(call.name, call.args);
      if (result.receipt || result.read) reads.push({ receipt: result.receipt, count: result.read?.count ?? 0, bytes: result.read?.bytes ?? 0 });
      if (result.suspend) {
        question = result.suspend;
        record("asked", result.suspend.draft ? `${result.suspend.question}\n\n${result.suspend.draft}` : result.suspend.question);
        responses.push(functionResponse(call.name, PENDING_ANSWER, false));
        continue;
      }
      record("result", result.content);
      responses.push(functionResponse(call.name, result.content, result.isError === true));
    }
    // The results go back as an ordinary user turn: DATA, never instructions (§4).
    contents.push({ role: "user", parts: responses });
    if (question) return done("waiting", { question });
  }
}

/**
 * The conversation of a paused run, with the user's answer in the place the model asked for it:
 * the pending function response becomes the answer, so the model reads it as the result of its
 * own question and never as a new instruction from nowhere.
 */
export function answered(contents: unknown[], answer: string): unknown[] {
  const out = structuredClone(contents) as Array<{ role?: string; parts?: Array<{ functionResponse?: { name?: string; response?: Record<string, unknown> } }> }>;
  const last = out[out.length - 1];
  const pending = last?.role === "user" ? last.parts?.find((p) => p.functionResponse?.name === "ask_user" && p.functionResponse.response?.result === PENDING_ANSWER) : undefined;
  if (pending?.functionResponse) pending.functionResponse.response = { result: `The user answered: ${answer}` };
  else out.push({ role: "user", parts: [{ text: `The user answered: ${answer}` } as never] });
  return out;
}

function functionResponse(name: string, content: string, isError: boolean): unknown {
  return { functionResponse: { name, response: isError ? { error: content } : { result: content } } };
}

/** A short, safe rendering of what a tool was asked to do, for the visible transcript. */
function summarise(args: Record<string, unknown>): string {
  return truncate(
    Object.entries(args)
      .map(([k, v]) => `${k}=${truncate(typeof v === "string" ? v : JSON.stringify(v), 80)}`)
      .join(" "),
    200,
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
