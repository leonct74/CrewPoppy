// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The helper prompt (AGENTS.md §9, the founder's idea of 2026-07-30; the AWS edition's
 * helper-prompt.ts is the reference): instead of training people on the New-agent form, hand
 * them a prompt that IS the training. They paste it into whatever AI they already talk to, add
 * one sentence about the job, and get back exactly what to type and tick.
 *
 * Built LIVE from the same catalogue the form renders — never a hand-maintained text. A helper
 * that recommends options the form does not have would be worse than none.
 */

export interface FormField {
  key: string;
  label: string;
  note: string;
}
export interface TierOption {
  value: "auto" | "light" | "standard" | "deep";
  label: string;
  note: string;
}

/** The catalogue the New-agent form renders — and the prompt is built from. */
export const FORM = {
  fields: [
    { key: "name", label: "Name", note: "a given name, so the agent feels like a teammate — e.g. Emma" },
    { key: "role", label: "Role", note: "the work it does, in a few honest words — e.g. Newsletter drafter" },
    { key: "instructions", label: "Brief", note: "what it does, how, in what tone, with what limits. Instructions never grant abilities: the agent can only write; it cannot send, publish or reach anything" },
  ] as FormField[],
  tiers: [
    { value: "auto", label: "Let the Planner choose", note: "the Planner judges each request and picks the cheapest model that fits — the default" },
    { value: "light", label: "Quick — the smallest model", note: "rewrites, summaries, short answers; the cheapest" },
    { value: "standard", label: "Standard model", note: "most everyday work" },
    { value: "deep", label: "Best — the deep model", note: "planning, analysis, long pieces; the dearest" },
  ] as TierOption[],
  memory: { label: "May read my memory", note: "the Planner reads the people and meetings from your memory poppy when a run is about your life — every read leaves a receipt on your Activity. Untick for agents that never need your life, and nothing of it is read" },
  cap: { label: "Monthly limit", note: "in dollars at CrewPoppy's ceiling price — a HARD cap; the agent stops when it reaches it", default: 5, min: 1, max: 100 },
  rules: [
    "The agent can only write. It cannot send an email, publish, or reach a website — the user decides what to do with its words.",
    "Your memory is read only when the agent may, and only through AgentsPoppy, with a receipt each time.",
    "The monthly limit, and the crew's own caps, are hard mechanisms; plan within them.",
    "Instructions are about the job and the judgement, never about the plumbing.",
  ],
} as const;

export function buildHelperPrompt(form: typeof FORM = FORM): string {
  const fieldLines = form.fields.map((f, i) => `${i + 1}. ${f.label} — ${f.note}.`).join("\n");
  const tierLines = form.tiers.map((t) => `  - "${t.label}" — ${t.note}`).join("\n");
  const shape = [...form.fields.map((f, i) => `${i + 1}. ${f.label}: …`), `${form.fields.length + 1}. Model: one of the four labels above, exactly as written`, `${form.fields.length + 2}. ${form.memory.label}: yes or no, with one line why`, `${form.fields.length + 3}. ${form.cap.label}: a whole number of dollars`].join("\n");
  return `You are helping me set up an AI agent in CrewPoppy — an app where my own crew of AI agents runs inside my own Google Cloud, reading the memory I keep there. I will describe, in my own words, what I want my agent to do. Your job: turn that into the exact values I should enter in CrewPoppy's "New agent" form. If my description is ambiguous or missing something important, ask me at most three short questions first.

THE FORM I WILL FILL IN:
${fieldLines}
${form.fields.length + 1}. Model (pick ONE):
${tierLines}
${form.fields.length + 2}. ${form.memory.label} — ${form.memory.note}.
${form.fields.length + 3}. ${form.cap.label} — ${form.cap.note}. Suggest a sensible number for the job (small jobs: $${form.cap.min}–3, working agents: $${form.cap.default}–10; the form allows $${form.cap.min} to $${form.cap.max}).

RULES OF THE PRODUCT (write a brief that respects these; never suggest working around them):
${form.rules.map((r) => `- ${r}`).join("\n")}

ANSWER IN EXACTLY THIS SHAPE:
${shape}
Then, on its own, the Brief as a paste-ready block.

MY AGENT SHOULD: `;
}
