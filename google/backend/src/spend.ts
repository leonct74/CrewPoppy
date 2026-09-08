// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The caps and the meter (DESIGN.md §7, unchanged on Google): hard mechanisms, not advice. The
 * counters are our own — calls and tokens the model reported — and the money line is computed at
 * a SAFETY CEILING deliberately above any published Gemini rate, so a limit stops early, never
 * late, and no price is ever guessed from memory (§7b). Google's bill is the final word.
 */

export interface SpendMonth {
  /** "2026-09" */
  month: string;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  /** Calls per day, "2026-09-08" → n — the daily cap's counter. */
  days: Record<string, number>;
  /** The month's cost at the ceiling, in US dollars — each call priced at its tier's ceiling rate. */
  ceilingUsd?: number;
  /** The same, per agent — the per-agent cap's counter (§7: "Research-Agent this month: $2.10 / $10 cap"). */
  agents?: Record<string, number>;
  lastCallAt?: string;
}

export interface Caps {
  callsPerDay: number;
  callsPerMonth: number;
  tokensPerMonth: number;
  /** The month's spend cap, in ceiling dollars (§14.6: $10 by default, never unlimited). */
  usdPerMonth: number;
}

/** Safe defaults, never unlimited (§14.6): a run is several calls since the tools came (G3c), a modest month, ten dollars. */
export const DEFAULT_CAPS: Caps = { callsPerDay: 60, callsPerMonth: 600, tokensPerMonth: 500_000, usdPerMonth: 10 };

/** US dollars per million tokens, in or out — the ceiling, not a price. */
export const CEILING_USD_PER_MILLION_TOKENS = 10;

export const monthOf = (iso: string): string => iso.slice(0, 7);
export const dayOf = (iso: string): string => iso.slice(0, 10);

export function emptyMonth(month: string): SpendMonth {
  return { month, calls: 0, promptTokens: 0, outputTokens: 0, days: {}, ceilingUsd: 0 };
}

/** Tokens priced at a ceiling rate (dollars per million); the default rate is the standard tier's. */
export function ceilingUsd(tokens: number, usdPerMillion = CEILING_USD_PER_MILLION_TOKENS): number {
  return (tokens / 1_000_000) * usdPerMillion;
}

/** "$0.03" — two decimals, never below a cent when anything was spent. */
export function usd(amount: number): string {
  if (amount === 0) return "$0.00";
  return `$${Math.max(0.01, Math.round(amount * 100) / 100).toFixed(2)}`;
}

/** Whether one more call fits under the caps; the reason when it does not. */
export function mayCall(spend: SpendMonth, caps: Caps, nowIso: string): { ok: true } | { ok: false; reason: string } {
  const today = spend.days[dayOf(nowIso)] ?? 0;
  if (today >= caps.callsPerDay) return { ok: false, reason: `today's limit of ${caps.callsPerDay} model calls is reached` };
  if (spend.calls >= caps.callsPerMonth) return { ok: false, reason: `this month's limit of ${caps.callsPerMonth} model calls is reached` };
  if (spend.promptTokens + spend.outputTokens >= caps.tokensPerMonth) return { ok: false, reason: `this month's limit of ${caps.tokensPerMonth.toLocaleString("en-GB")} tokens is reached` };
  if ((spend.ceilingUsd ?? 0) >= caps.usdPerMonth) return { ok: false, reason: `this month's spending limit of ${usd(caps.usdPerMonth)} (at the ceiling) is reached` };
  return { ok: true };
}

export function recordCall(spend: SpendMonth, promptTokens: number, outputTokens: number, nowIso: string, callUsd = ceilingUsd(promptTokens + outputTokens), agentId?: string): SpendMonth {
  const day = dayOf(nowIso);
  return {
    ...spend,
    calls: spend.calls + 1,
    promptTokens: spend.promptTokens + promptTokens,
    outputTokens: spend.outputTokens + outputTokens,
    days: { ...spend.days, [day]: (spend.days[day] ?? 0) + 1 },
    ceilingUsd: (spend.ceilingUsd ?? 0) + callUsd,
    ...(agentId ? { agents: { ...(spend.agents ?? {}), [agentId]: (spend.agents?.[agentId] ?? 0) + callUsd } } : {}),
    lastCallAt: nowIso,
  };
}

/** What one agent has spent this month, at the ceiling. */
export function agentSpent(spend: SpendMonth, agentId: string): number {
  return spend.agents?.[agentId] ?? 0;
}

/** The one always-current money line (§7b). */
export function describeMeter(spend: SpendMonth, caps: Caps): string {
  const tokens = spend.promptTokens + spend.outputTokens;
  const calls = `${spend.calls} model ${spend.calls === 1 ? "call" : "calls"}`;
  const cost = tokens === 0 ? "nothing spent" : `${tokens.toLocaleString("en-GB")} tokens, at most ${usd(spend.ceilingUsd ?? ceilingUsd(tokens))} at the ceiling`;
  return `This month: ${calls} · ${cost} · limits ${usd(caps.usdPerMonth)} a month at the ceiling, ${caps.callsPerDay} calls a day.`;
}
