// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The Planner — the crew's main agent (DESIGN.md §18, G3; the founder's decision of 2026-09-08:
 * "to optimise the tokens spent, a main agent reads the memory and, from the user's request and
 * the difficulty of the task, decides which model should run it — beside the pre-built agents
 * for defined tasks, the user will ask unplanned tasks on the fly, of different complexity").
 *
 * The Planner spends no tokens deciding: the tier comes from rules a person can read on the
 * page ("a light task — short, a rewrite"), and the user can overrule it per request. The
 * cheapest tier is no model at all — a question the memory answers by itself.
 */

export type Tier = "none" | "light" | "standard" | "deep";

export interface TierSpec {
  tier: Tier;
  /** The Vertex AI model id; empty for "none". */
  model: string;
  /** Words on the page and the receipt. */
  words: string;
  /** Most words the answer may run to. */
  maxWords: number;
  maxOutputTokens: number;
  /** The safety ceiling, US dollars per million tokens — above any published rate for the model. Counts the caps. */
  ceilingUsdPerMillion: number;
  /**
   * Google's published Vertex AI price, US dollars per million tokens in and out
   * (cloud.google.com/vertex-ai/generative-ai/pricing, read 2026-09-08; Pro's rate for prompts up to
   * 200k tokens). SHOWN beside the tokens, never used for a cap — the founder's rule: say what was
   * used and what Google charges for it, and keep the ceiling as the hard stop only.
   */
  listUsdPerMillion: { in: number; out: number };
}

/** "$0.10 in, $0.40 out per million tokens" — Google's price for the tier's model, in plain words. */
export function priceLine(tier: TierSpec): string {
  if (tier.tier === "none") return "no tokens";
  return `$${tier.listUsdPerMillion.in.toFixed(2)} in, $${tier.listUsdPerMillion.out.toFixed(2)} out per million tokens`;
}

export const TIERS: Record<Tier, TierSpec> = {
  none: { tier: "none", model: "", words: "no model — answered from your memory", maxWords: 0, maxOutputTokens: 0, ceilingUsdPerMillion: 0, listUsdPerMillion: { in: 0, out: 0 } },
  light: { tier: "light", model: "gemini-2.5-flash-lite", words: "Gemini 2.5 Flash-Lite on Vertex AI", maxWords: 150, maxOutputTokens: 400, ceilingUsdPerMillion: 5, listUsdPerMillion: { in: 0.1, out: 0.4 } },
  standard: { tier: "standard", model: "gemini-2.5-flash", words: "Gemini 2.5 Flash on Vertex AI", maxWords: 300, maxOutputTokens: 900, ceilingUsdPerMillion: 10, listUsdPerMillion: { in: 0.3, out: 2.5 } },
  deep: { tier: "deep", model: "gemini-2.5-pro", words: "Gemini 2.5 Pro on Vertex AI", maxWords: 700, maxOutputTokens: 2_000, ceilingUsdPerMillion: 40, listUsdPerMillion: { in: 1.25, out: 10 } },
};

/** What the user may ask for beside "let the Planner choose". */
export type TierChoice = "auto" | "quick" | "standard" | "best";

export interface Plan {
  tier: Tier;
  /** One line a person can read: why this tier. */
  why: string;
  /** Whether the request is about the user's own life — then the memory is read first. */
  wantsMemory: boolean;
  /** The words to search the memory with, when it is read. */
  memoryQuery: string;
  /** For "none": the memory question the crew answers without a model. */
  lookup?: "next" | "last-met" | "who" | "search";
  /** False when no rule fired and the standard tier is only the fallback — the judge's cue (G3c). */
  placed?: boolean;
}

const LOOKUP_NEXT = /\b(what('?s| is) (on|in) my (calendar|diary|schedule)|what('?s| is) next|next meeting|anything (on|today|tomorrow|this week)|my (day|week|schedule) (today|tomorrow)?)\b/i;
const LOOKUP_LAST_MET = /\b(when did i (last )?(meet|see|speak|talk)( to| with)?|last (time|meeting) with)\b/i;
const LOOKUP_WHO = /^\s*who (is|was) \b/i;
const ABOUT_MY_LIFE = /\b(my|me|i|i've|i'm|mine|our|we|we've|we're|us)\b/i;
const PEOPLE_AND_TIME = /\b(meet|meeting|meetings|meetup|met|went|attended|organi[sz]ed|calendar|diary|schedule|appointment|call|lunch|dinner|coffee|visit|trip|event|conference|workshop|talk|party|wedding|birthday|anniversary|yesterday|today|tomorrow|last (week|month|year)|next (week|month)|this (week|month)|ago|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const LIGHT_VERBS = /^\s*(summari[sz]e|shorten|rewrite|reword|rephrase|translate|proofread|correct|fix|tidy|list|name|give me (three|3|five|5|a few)|draft a (short|quick|brief)|reply to|answer (this|briefly)|what does .* mean|define|spell)\b/i;
const DEEP_VERBS = /\b(plan|strategy|strategi[sz]e|analy[sz]e|analysis|compare|research|design|architect|investigate|evaluate|assess|review in depth|write (a|an|the) (report|essay|proposal|whitepaper|article|specification|spec|document|business plan|long)|step[- ]by[- ]step|roadmap|pros and cons|trade-?offs)\b/i;

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const questions = (s: string): number => (s.match(/\?/g) ?? []).length;

/** The words worth searching the memory with: the request minus its stop words. */
export function memoryQueryOf(request: string): string {
  const stop = new Set("a an the and or of to in on at for with by from is are was were be been do does did i me my mine we our you your it its this that these those what when who where why how which please can could would should tell about last next".split(" "));
  return request
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@.'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stop.has(w))
    .slice(0, 8)
    .join(" ");
}

export function classify(request: string, choice: TierChoice = "auto"): Plan {
  const words = wordCount(request);
  const aboutMe = ABOUT_MY_LIFE.test(request) && PEOPLE_AND_TIME.test(request);
  const wantsMemory = aboutMe || LOOKUP_WHO.test(request);
  const memoryQuery = memoryQueryOf(request);
  if (choice === "quick") return { tier: "light", why: "you asked for a quick answer", wantsMemory, memoryQuery };
  if (choice === "standard") return { tier: "standard", why: "you asked for the standard model", wantsMemory, memoryQuery };
  if (choice === "best") return { tier: "deep", why: "you asked for the best model", wantsMemory, memoryQuery };

  if (LOOKUP_NEXT.test(request)) return { tier: "none", why: "a look at your calendar — your memory answers this by itself", wantsMemory: true, memoryQuery, lookup: "next" };
  if (LOOKUP_LAST_MET.test(request)) return { tier: "none", why: "a question your memory answers by itself: the last time you met someone", wantsMemory: true, memoryQuery, lookup: "last-met" };
  if (LOOKUP_WHO.test(request) && words <= 6) return { tier: "none", why: "a name your memory can answer by itself", wantsMemory: true, memoryQuery, lookup: "who" };

  if (DEEP_VERBS.test(request) || words > 120 || questions(request) >= 3 || request.length > 2_000) {
    return { tier: "deep", why: DEEP_VERBS.test(request) ? "a task that needs reasoning — planning, analysis or a long piece" : words > 120 || request.length > 2_000 ? "a long request" : "several questions at once", wantsMemory, memoryQuery };
  }
  if (LIGHT_VERBS.test(request) || (words <= 25 && !aboutMe)) {
    return { tier: "light", why: LIGHT_VERBS.test(request) ? "a light task — a rewrite, a summary, a short answer" : "a short question", wantsMemory, memoryQuery };
  }
  return { tier: "standard", why: aboutMe ? "a question about your own life — your memory first, then the standard model" : "an ordinary task", wantsMemory, memoryQuery, placed: aboutMe };
}
