// Turning tokens into dollars — the "show the money" rule (AGENTS.md §9, DESIGN §7).
//
// HONESTY RULE: we show a cost ONLY for models whose per-token rate we have actually
// measured. Where we have no rate we show the token counts and say the price isn't
// available, rather than inventing a number. A confidently wrong cost is worse than an
// absent one on a screen whose entire job is trust.
//
// WHY A TABLE AND NOT A LIVE QUERY: AGENTS.md §9 says never hardcode prices and to use
// `pricing:GetProducts`. But that action cannot be IAM-scoped (verified: AccessDenied
// under any ARN pattern, allowed only on `*`), and a wildcard read costs the manifest's
// "no risks to other resources" verdict — see DESIGN §2d. Until that's resolved, these
// rates are MEASURED from the live Price List API and carried with a date, and every
// figure derived from them is labelled approximate.
//
// Measured 2026-07-26, eu-west-1, on-demand, USD per 1K tokens.
// Claude 4.5-era models are deliberately absent: the Price List API publishes no rows
// for them in eu-west-1 (they're reached through cross-region inference profiles), and
// guessing would violate the honesty rule above.

import type { RunCost, TokenUsage } from "./types";

export interface TokenRate {
  /** USD per 1,000 input tokens. */
  inPer1K: number;
  /** USD per 1,000 output tokens. */
  outPer1K: number;
}

/** When these rates were read from the AWS Price List API. */
export const RATES_MEASURED_ON = "2026-07-26";

export const TOKEN_RATES: Record<string, TokenRate> = {
  "amazon.nova-lite-v1:0": { inPer1K: 0.00007, outPer1K: 0.00028 },
  "qwen.qwen3-32b-v1:0": { inPer1K: 0.00009, outPer1K: 0.00035 },
  "openai.gpt-oss-120b-1:0": { inPer1K: 0.00009, outPer1K: 0.00035 },
};

/**
 * A deliberately EXPENSIVE per-token rate, used ONLY to keep the spend cap working for
 * models whose real price we don't have.
 *
 * WHY THIS EXISTS: displaying an invented price would be dishonest, so `costFor` returns
 * undefined and the UI says "unavailable". But feeding that undefined into the spend
 * counter meant nothing accumulated — and a monthly cap that can never be reached is not
 * a cap. Measured live: a Claude Sonnet run recorded 175/288 tokens and $0 spend.
 *
 * So the two questions are answered separately. What we SHOW the user admits ignorance;
 * what we ASSUME for safety errs upward. This rate is set above every model in the
 * catalogue, so cap accounting over-estimates rather than under-estimates: the worst
 * case is an agent that stops sooner than strictly necessary, never one that runs past
 * its ceiling. Never use it for display.
 */
export const CAP_CEILING_RATE: TokenRate = { inPer1K: 0.005, outPer1K: 0.02 };

/**
 * What to charge against the monthly cap. ALWAYS a number: an unknown rate falls back to
 * {@link CAP_CEILING_RATE} so the guardrail keeps working for every model.
 */
export function capCostFor(modelId: string, usage: TokenUsage): number {
  const rate = TOKEN_RATES[modelId] ?? CAP_CEILING_RATE;
  return (usage.inputTokens / 1000) * rate.inPer1K + (usage.outputTokens / 1000) * rate.outPer1K;
}

/** True when the spend charged for this model is an upper-bound guess, not its real price. */
export function isEstimatedForCap(modelId: string): boolean {
  return !TOKEN_RATES[modelId];
}

/**
 * Cost for a run's token usage. Returns `usd: undefined` when we have no verified rate
 * — the caller must then show tokens only, and say why.
 */
export function costFor(modelId: string, usage: TokenUsage): RunCost {
  const rate = TOKEN_RATES[modelId];
  if (!rate) return { usage };
  const usd = (usage.inputTokens / 1000) * rate.inPer1K + (usage.outputTokens / 1000) * rate.outPer1K;
  return { usage, usd, approx: true };
}

/**
 * Format a cost for display. Sub-cent amounts are the norm for a single run, so we keep
 * enough precision to avoid showing "$0.00" for something that did cost money — a $0.00
 * that isn't really zero undermines the whole cost meter.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** The calendar month key a run's spend counts against, e.g. "2026-07". */
export function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}
