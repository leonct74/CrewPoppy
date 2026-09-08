// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The helper prompt (AGENTS.md §9, the founder's idea of 2026-07-30; the AWS edition's
 * helper-prompt.ts is the reference): instead of training people on the New-agent form, hand
 * them a prompt that IS the training. They paste it into whatever AI they already talk to, add
 * one sentence about the job, and get back exactly what to type and tick.
 *
 * Built LIVE from the same catalogue the form renders — never a hand-maintained text. A helper
 * that recommends options the form does not have would be worse than none. The tools come from
 * the backend's fixed catalogue, the one the dispatcher enforces.
 */
import { DEFAULT_TOOLS, TOOL_GROUPS, TOOL_NOTES, type ToolName } from "../../backend/src/tools";

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
export interface ToolOption {
  value: ToolName;
  label: string;
  what: string;
  risk?: string;
  /** Ticked on a new agent. */
  default: boolean;
}
export interface ToolGroupOption {
  key: string;
  label: string;
  what: string;
  tools: ToolOption[];
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
  memory: { label: "May read my memory", note: "the Planner reads the people and meetings from your memory poppy when a run is about your life, and the agent may search it itself — every read leaves a receipt on your Activity. Untick for agents that never need your life, and nothing of it is read" },
  /** The tools an owner ticks; the memory search is the memory tick above, so its group is left out here. */
  tools: TOOL_GROUPS.filter((g) => g.key !== "memory").map((g) => ({
    key: g.key,
    label: g.label,
    what: g.what,
    tools: g.tools.map((t) => ({ value: t, label: TOOL_NOTES[t].label, what: TOOL_NOTES[t].what, ...(TOOL_NOTES[t].risk ? { risk: TOOL_NOTES[t].risk } : {}), default: DEFAULT_TOOLS.includes(t) })),
  })) as ToolGroupOption[],
  schedule: { label: "Runs by itself", note: "off, or every hour, every day at a time, or every week on a day — on your own clock, minutes in steps of five. While CrewPoppy is open; a time it slept through is run at the next chance, and the run says so" },
  cap: { label: "Monthly limit", note: "in dollars at CrewPoppy's ceiling price — a HARD cap; the agent stops when it reaches it", default: 5, min: 1, max: 100 },
  rules: [
    "The agent can only write. It cannot send an email, publish, or reach a website — the user decides what to do with its words.",
    "Its tools come from a fixed catalogue: its own notes and files, the pause to ask the user, and — when it may read the memory — a search of the user's memory poppy. Nothing else exists, whatever the brief says.",
    "Your memory is read only when the agent may, and only through AgentsPoppy, with a receipt each time.",
    "The monthly limit, and the crew's own caps, are hard mechanisms; plan within them.",
    "Instructions are about the job and the judgement, never about the plumbing.",
  ],
} as const;

export function buildHelperPrompt(form: typeof FORM = FORM): string {
  const fieldLines = form.fields.map((f, i) => `${i + 1}. ${f.label} — ${f.note}.`).join("\n");
  const tierLines = form.tiers.map((t) => `  - "${t.label}" — ${t.note}`).join("\n");
  const toolLines = form.tools.map((g) => `  ${g.label} — ${g.what}\n${g.tools.map((t) => `    - "${t.label}" — ${t.what}${t.risk ? ` (${t.risk})` : ""}`).join("\n")}`).join("\n");
  const n = form.fields.length;
  const shape = [
    ...form.fields.map((f, i) => `${i + 1}. ${f.label}: …`),
    `${n + 1}. Model: one of the four labels above, exactly as written`,
    `${n + 2}. ${form.memory.label}: yes or no, with one line why`,
    `${n + 3}. Tools: the labels to tick, one per line, each with one line why — and which to leave unticked`,
    `${n + 4}. ${form.schedule.label}: off, or "every hour", "every day at HH:MM" or "every <weekday> at HH:MM"`,
    `${n + 5}. ${form.cap.label}: a whole number of dollars`,
  ].join("\n");
  return `You are helping me set up an AI agent in CrewPoppy — an app where my own crew of AI agents runs inside my own Google Cloud, reading the memory I keep there. I will describe, in my own words, what I want my agent to do. Your job: turn that into the exact values I should enter in CrewPoppy's "New agent" form. If my description is ambiguous or missing something important, ask me at most three short questions first.

THE FORM I WILL FILL IN:
${fieldLines}
${n + 1}. Model (pick ONE):
${tierLines}
${n + 2}. ${form.memory.label} — ${form.memory.note}.
${n + 3}. Tools (tick the ones the job needs; every tool is scoped to the agent alone):
${toolLines}
${n + 4}. ${form.schedule.label} — ${form.schedule.note}.
${n + 5}. ${form.cap.label} — ${form.cap.note}. Suggest a sensible number for the job (small jobs: $${form.cap.min}–3, working agents: $${form.cap.default}–10; the form allows $${form.cap.min} to $${form.cap.max}).

RULES OF THE PRODUCT (write a brief that respects these; never suggest working around them):
${form.rules.map((r) => `- ${r}`).join("\n")}

ANSWER IN EXACTLY THIS SHAPE:
${shape}
Then, on its own, the Brief as a paste-ready block.

MY AGENT SHOULD: `;
}
