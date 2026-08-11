// The AI helper prompt (founder idea, 2026-07-30): instead of training people on the
// agent form, hand them a prompt that IS the training. They paste it into whatever AI
// they already talk to, add one sentence about the job, and get back a complete recipe —
// instructions to paste, boxes to tick, fields to fill. Every agent created this way
// teaches the product as a side effect.
//
// Built LIVE from the same catalogue the form renders, never maintained by hand: a new
// capability appears here the same instant its checkbox appears in the editor. A stale
// helper that recommends options the form doesn't have would be worse than none.

import type { ModelChoice, Recipe, ToolCatalogue } from "./types";

export function buildHelperPrompt(catalogue: ToolCatalogue, models: ModelChoice[]): string {
  const capabilityLines = catalogue.groups
    .map((g) => {
      const tools = g.tools
        .map((t) => catalogue.tools.find((o) => o.name === t))
        .filter((o): o is NonNullable<typeof o> => !!o)
        .map((o) => `  - "${o.label}" — ${o.what}${o.risk ? ` (caution: ${o.risk})` : ""}`)
        .join("\n");
      return `- Group "${g.label}" (${g.what}):\n${tools}`;
    })
    .join("\n");

  const modelLines = models
    .filter((m) => m.supported !== false)
    .map((m) => `  - ${m.label} (price class ${m.cost}) — ${m.goodAt}`)
    .join("\n");

  return `You are helping me set up an AI agent in CrewPoppy — an app where task-specific AI agents run entirely in my own AWS account. I will describe, in my own words, what I want my agent to do. Your job: turn that into the exact values I should enter in CrewPoppy's "New agent" form. If my description is ambiguous or missing something important, ask me at most three short questions first.

THE FORM I WILL FILL IN:
1. Name — a given name, so the agent feels like a teammate (e.g. "Emma").
2. Role — the work it does (e.g. "Customer Support"). Short, honest, no buzzwords.
3. Instructions — the brief: what it does, how, in what tone, with what limits. IMPORTANT: instructions never grant abilities. Knowing how to write is built in; reaching an inbox or saving a file is a CAPABILITY, ticked separately below. Write instructions about the job and the judgement, not the plumbing.
4. Which model does the thinking (pick ONE):
${modelLines || "  - (the form lists the available models; the default is fine)"}
5. Spending limit per month, in dollars — a HARD cap; the agent stops when it reaches it. Suggest a sensible number for the job (small jobs: $3–5, working agents: $10).

CAPABILITIES (tick ONLY what the job needs — everything starts off):
${capabilityLines}

SCHEDULE (optional — only if the agent should run by itself):
- Every hour / every day / every week, at a chosen time and timezone, plus the task it performs each time. Suggest one only if the job is genuinely recurring.

EMAIL SETUP (only if an email capability is ticked):
- IMPORTANT — whenever the job involves the agent RECEIVING email, or sending from its own address, say this to me plainly in your answer: the agent needs a mailbox on my own domain, created with MailPoppy (the mail poppy in AgentsPoppy — my own mail system, in my own AWS). In MailPoppy I create the mailbox (e.g. support@mydomain.com) and flip "Assign this mailbox to an AI agent"; it then appears in CrewPoppy's dropdown. The one exception that needs no MailPoppy: an agent that only SENDS me reports and approval requests at my own existing address — that's outgoing mail only, from an address I verify in AWS with one click; the agent receives nothing.
- Field 1: the address I use to approve agent tasks — this is MY address; approval requests and reports come here.
- Field 2: the address the agent OWNS (chosen from mailboxes I've assigned to agents in MailPoppy). Only needed if people should be able to email the agent, or it should send from its own identity.
- Field 3: who may email the agent — "Only me" (default) or "Anyone" (for a support@ style agent). Opening it never widens what the agent may DO: every reply to an outsider still waits for my approval.

RULES OF THE PRODUCT (write instructions that respect these; never suggest working around them):
- Emails to anyone other than me ALWAYS pause for my explicit approval — by design, not by instruction.
- The agent can read and write only its own files, in its own workspace.
- If the agent should follow a template (invoices, offers), tell me to upload the template as a file in its workspace FIRST, and reference it by name in the instructions. Draft that template for me too.
- The daily email cap and the monthly spending cap are hard mechanisms; plan within them.

ANSWER IN EXACTLY THIS SHAPE:
1. Name: …
2. Role: …
3. Instructions: (a ready-to-paste block, 60–200 words, first line strong — the crew view shows the first three lines)
4. Model: … (one line why)
5. Spending limit: $… (one line why)
6. Tick these capabilities: … (each with one line why; list nothing the job doesn't need)
7. Schedule: … or "none"
8. Email setup: … or "not needed" (include the MailPoppy step when the agent needs its own address)
9. Files to upload first: … with a ready-to-paste draft of each, or "none"

MY AGENT SHOULD: `;
}


/**
 * The helper prompt for a TEMPLATE (founder, 2026-08-11): the user picked a ready-made
 * agent and wants an AI to walk them through what it does and how to make it theirs.
 *
 * Reuses buildHelperPrompt VERBATIM as the product knowledge — one source of truth, so
 * the template variant can never disagree with the form or go stale — and prepends the
 * template itself plus a different mission: explain first, then customise.
 */
export function buildTemplateHelperPrompt(
  recipe: Recipe,
  catalogue: ToolCatalogue,
  models: ModelChoice[],
): string {
  const labelFor = (t: string) => catalogue.tools.find((o) => o.name === t)?.label ?? t;
  const schedule = recipe.schedule
    ? `${recipe.schedule.kind === "hourly" ? "Every hour" : recipe.schedule.kind === "daily" ? `Every day at ${String(recipe.schedule.hour).padStart(2, "0")}:${String(recipe.schedule.minute).padStart(2, "0")}` : "Every week"} — task: ${recipe.schedule.task}`
    : "none";
  const files = (recipe.files ?? [])
    .map((f) => `--- file: ${f.path} ---\n${f.content}`)
    .join("\n\n");

  return `You are helping me adopt a READY-MADE agent template in CrewPoppy — an app where task-specific AI agents run entirely in my own AWS account. The template below will pre-fill CrewPoppy's "New agent" form; nothing exists until I press save, and I can change anything first.

Do this, in order:
1. EXPLAIN the template in plain words: what this agent will do day to day, what each pre-ticked capability is for, what the schedule means (including that a scheduled agent keeps running until I untick it, and that the monthly spending limit is the hard stop), and what its starter files are for.
2. ASK me what I want different — my details, my language, my routine. At most three short questions at a time.
3. ANSWER with the exact edited values to put in the form, in the ANSWER shape given at the end. Only change what I asked to change; keep the rest of the template as it is, and never suggest ticking a capability the job doesn't need.

THE TEMPLATE I PICKED — "${recipe.name}" (${recipe.role}):

Instructions as pre-filled:
"""
${recipe.instructions}
"""

Pre-ticked capabilities: ${recipe.tools.map(labelFor).join(", ")}
Monthly spending limit: $${recipe.capUsd}${recipe.maxTokensPerRun ? `
Per-run token budget: ${recipe.maxTokensPerRun.toLocaleString("en-US")} (web pages are big — do not lower this if the agent reads the web)` : ""}
Schedule: ${schedule}
${files ? `
Starter files written into the agent's folder:
${files}
` : ""}
EVERYTHING BELOW IS THE PRODUCT KNOWLEDGE YOU NEED — the same form guide CrewPoppy gives for building an agent from scratch. Use it to explain and to customise, and respect its rules.

${buildHelperPrompt(catalogue, models).replace(/\n\nMY AGENT SHOULD: $/, "")}

(Instead of describing an agent from scratch, I am starting from the template above. Begin with step 1: explain it to me.)`;
}
