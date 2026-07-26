// The hard spend/effort limits (DESIGN §7). The single most important module in
// CrewPoppy: "LLM tokens + an agent in a loop = the fastest way to a surprise bill in
// the whole poppy family", so these are MECHANISMS, not advice.
//
// Everything here is pure and synchronous so it can be unit-tested exhaustively and
// called from inside the runner's loop without any I/O in the hot path. A runaway agent
// must be impossible, not merely unlikely.

import type { AgentCaps, StopReason, TokenUsage } from "./types";

export interface LoopState {
  iterations: number;
  usage: TokenUsage;
  /** ms elapsed since the run started. */
  elapsedMs: number;
  /** Dollars this agent has already spent this calendar month, INCLUDING this run. */
  monthSpendUsd: number;
}

export interface GuardrailVerdict {
  /** True when the loop may continue / the run may start. */
  ok: boolean;
  /** Which limit stopped it. Absent when ok. */
  reason?: StopReason;
  /** One calm sentence for the user — never a raw number dump (AGENTS.md §9). */
  message?: string;
}

const OK: GuardrailVerdict = { ok: true };

/**
 * May this run START? Refuses when the agent has already reached its monthly cap, so
 * a capped agent cannot begin work it can't pay for (DESIGN §7: "the runner refuses to
 * start a run that could exceed it").
 */
export function checkStart(caps: AgentCaps, monthSpendUsd: number): GuardrailVerdict {
  if (monthSpendUsd >= caps.monthlySpendCapUsd) {
    return {
      ok: false,
      reason: "monthly_spend_cap",
      message: `This agent has reached its spending limit for this month ($${caps.monthlySpendCapUsd.toFixed(2)}). Raise the limit, or wait until next month.`,
    };
  }
  return OK;
}

/**
 * May the loop take ANOTHER turn? Checked before every model call, so a limit stops the
 * run at the boundary rather than after the spend has already happened.
 *
 * Order matters only for which message the user sees; all four are absolute.
 */
export function checkContinue(caps: AgentCaps, state: LoopState): GuardrailVerdict {
  if (state.iterations >= caps.maxIterations) {
    return {
      ok: false,
      reason: "max_iterations",
      message: `The agent stopped after ${caps.maxIterations} steps — its limit for a single run.`,
    };
  }
  const total = state.usage.inputTokens + state.usage.outputTokens;
  if (total >= caps.maxTokensPerRun) {
    return {
      ok: false,
      reason: "max_tokens",
      message: "The agent reached the amount of text it's allowed to process in one run.",
    };
  }
  if (state.elapsedMs >= caps.maxWallClockMs) {
    return {
      ok: false,
      reason: "max_wall_clock",
      message: `The agent ran out of time — runs are limited to ${Math.round(caps.maxWallClockMs / 1000)} seconds.`,
    };
  }
  if (state.monthSpendUsd >= caps.monthlySpendCapUsd) {
    return {
      ok: false,
      reason: "monthly_spend_cap",
      message: `The agent stopped because it reached its spending limit for this month ($${caps.monthlySpendCapUsd.toFixed(2)}).`,
    };
  }
  return OK;
}

/**
 * The largest number of tokens the next call may be allowed to produce, so a single
 * response cannot blow past the per-run token cap. Never returns more than the caller's
 * ceiling, and never less than zero.
 */
export function remainingOutputBudget(caps: AgentCaps, usage: TokenUsage, ceiling: number): number {
  const used = usage.inputTokens + usage.outputTokens;
  return Math.max(0, Math.min(ceiling, caps.maxTokensPerRun - used));
}

/** Normalise user-supplied caps: never unlimited, never negative, never absurd. */
export function sanitiseCaps(caps: Partial<AgentCaps>, defaults: AgentCaps): AgentCaps {
  const clamp = (v: unknown, dflt: number, min: number, max: number) => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
    return Math.min(max, Math.max(min, n));
  };
  return {
    maxIterations: clamp(caps.maxIterations, defaults.maxIterations, 1, 50),
    maxTokensPerRun: clamp(caps.maxTokensPerRun, defaults.maxTokensPerRun, 100, 500_000),
    maxWallClockMs: clamp(caps.maxWallClockMs, defaults.maxWallClockMs, 5_000, 840_000),
    // A zero cap would mean "never run"; we allow it (a deliberate pause) but not below.
    monthlySpendCapUsd: clamp(caps.monthlySpendCapUsd, defaults.monthlySpendCapUsd, 0, 10_000),
  };
}
