// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The light-model judge (DESIGN.md §18, G3c): for the requests the Planner's rules cannot place,
 * the smallest model reads the request and answers one word — light, standard or deep. A few
 * dozen tokens at the lowest rate, counted like any call; the rules stay first, and the answer
 * carries the judge's word so a person can see it was asked.
 */
import { TIERS, type Tier } from "./planner";
import type { Model } from "./vertex";

export const JUDGE_INSTRUCTIONS =
  "You route requests to the right size of model. Read the REQUEST and answer with exactly one word: LIGHT for a short, simple task (a rewrite, a summary, a short factual answer, a quick list); STANDARD for ordinary work (a draft, a message, an explanation, a few paragraphs); DEEP for work that needs real reasoning (planning, analysis, comparison, a long or careful piece). Nothing but the one word.";
const JUDGE_MAX_OUTPUT_TOKENS = 8;
const JUDGE_MAX_CHARS = 2_000;

export interface Judgement {
  tier: Exclude<Tier, "none">;
  promptTokens: number;
  outputTokens: number;
  model: string;
}

/** The judge's word, or null when it gave none the rules can use — then the rules' own placement stands. */
export async function judgeTier(model: Model, request: string): Promise<Judgement | null> {
  const spec = TIERS.light;
  try {
    const reply = await model.generate(JUDGE_INSTRUCTIONS, `REQUEST:\n${request.length > JUDGE_MAX_CHARS ? `${request.slice(0, JUDGE_MAX_CHARS)}…` : request}`, JUDGE_MAX_OUTPUT_TOKENS, spec.model);
    const word = /\b(light|standard|deep)\b/i.exec(reply.text)?.[1]?.toLowerCase() as Judgement["tier"] | undefined;
    if (!word) return null;
    return { tier: word, promptTokens: reply.promptTokens, outputTokens: reply.outputTokens, model: reply.model };
  } catch {
    return null;
  }
}

/** "the small model judged it a light task" */
export function judgeWords(tier: Judgement["tier"]): string {
  return `the small model judged it ${tier === "light" ? "a light task" : tier === "deep" ? "a task that needs reasoning" : "an ordinary task"}`;
}
