// Ready-made agent setups — the §15l recipe catalogue.
//
// A recipe is DATA, and that is the load-bearing rule (DESIGN §15l): applying one fills
// the editor and STOPS. The owner still reads the brief, still sees every capability
// tick, still presses save. A recipe can suggest "Read web pages"; it cannot grant it —
// otherwise "use this template" becomes a way to talk someone through a granting
// ceremony they never read, which is exactly what the ceremony exists to prevent.
//
// ONLY SHIP WHAT HAS BEEN RUN (§15l). Every recipe here names the live run that backs
// it. Anyone can generate plausible prompts; a template that fails on first contact
// costs more trust than the empty box it replaced. Candidates that are not yet backed
// by a real run don't ship — they wait, they don't get listed as "beta".
//
// Two different things are called "templates" around here (§15l): the DOCUMENT templates
// in an agent's workspace (invoice-template.md) and these, the setup of the agent
// itself. A recipe may CARRY workspace files — the offer-writer is useless without the
// document template it is told to follow — which the app writes into the new agent's
// folder after creation, through the same PUT /agents/:id/files path the Files panel
// uses. No new mechanism, no new permission.

import type { ToolName } from "./tools";

/** The schedule a recipe suggests. Mirrors AgentSchedule minus the per-install fields. */
export interface RecipeSchedule {
  kind: "hourly" | "daily" | "weekly";
  hour: number;
  minute: number;
  weekday: number;
  task: string;
}

export interface RecipeFile {
  path: string;
  content: string;
}

export interface Recipe {
  key: string;
  /** Suggested agent name — the owner can rename in the editor like anything else. */
  name: string;
  role: string;
  avatar: string;
  /** The card's one-liner: what you get, in the owner's language. */
  blurb: string;
  /** What must stay true for it to work — shown on the card AND kept honest. */
  needs: string[];
  /** The .md brief that lands in the instructions box. */
  instructions: string;
  /** Suggested capability ticks. Pre-checked in the editor, never silently granted. */
  tools: ToolName[];
  /** Suggested monthly cap in USD — sized to the job, not a global default. */
  capUsd: number;
  /** Suggested per-run token budget. Web reading needs more than chat (DESIGN §4f). */
  maxTokensPerRun?: number;
  schedule?: RecipeSchedule;
  files?: RecipeFile[];
}

// ⛔ WITHDRAWN 2026-08-11: the flight-price watcher (Jerry). It is not in this list on
// purpose, and it must not be restored until a source exists that survives repeated use.
//
// What happened, in order: the first live run from the founder's Lambda read Google
// Flights perfectly and reported a €90 fare. Later runs got a LOADING SHELL. Then 403s.
// The same URL from a laptop returned nine fares throughout — 8 tries out of 8. The
// difference is the EGRESS, not the URL, the date or the parser: Google progressively
// blocks a datacentre address that keeps asking, and Lambda leaves from an AWS range.
//
// That is worse than never working. It passes a demo on a fresh deployment and dies in
// use, so it fails exactly the §15l rule this catalogue exists to keep: ship only what
// has been RUN — which has to mean run repeatedly, from where the agent actually runs.
//
// I shipped three releases (0.6.0, 0.6.1, 0.6.2) chasing this from the wrong machine.
// The parser fix and the missing-date fix in those releases were real and are keeping
// their place; the mistake was believing a laptop could stand in for the Lambda.
//
// The route back is a flight API with an owner-supplied key (Amadeus Self-Service has a
// free tier, Duffel and Kiwi are alternatives) — DESIGN §4f's P6b provider seam, which
// was set aside precisely because a laptop test made flights look solved. Restore this
// recipe only when it has run from a real deployment, several times, over days.
export const RECIPES: Recipe[] = [
  {
    // Backed by the longest-running live use there is: Max, the review-demo agent,
    // writes offers as PDFs from invoices-template.md and routes them through the
    // approval gate (P2 live-verified; used for the store screenshots and reviews).
    key: "offer-writer",
    name: "Max",
    role: "Writes offers and invoices",
    avatar: "av-07",
    blurb:
      "Give it your invoice template once. Then one message — customer, amount, what for — " +
      "gets you a finished PDF, and nothing is emailed until you approve it.",
    needs: [
      "Files and PDFs — the documents have to live somewhere",
      "Email other people — every send still waits for your approval",
    ],
    instructions: [
      "You write offers and invoices for your owner's business.",
      "",
      "Follow offer-template.md in your files EXACTLY — structure, wording, footer. Fill in",
      "the customer, the work and the amounts from what your owner tells you. Number",
      "documents in sequence; remember the last number in your memory.",
      "",
      "Save every finished document as a PDF in your files, named like offer-ACME-001.pdf.",
      "",
      "If your owner asks you to send it, attach the PDF. The send always waits for their",
      "approval, so write the covering message ready to go: short, plain, no flourishes.",
      "",
      "If a detail is missing — a price, a company name — ask; never invent it.",
    ].join("\n"),
    tools: [
      "workspace_list",
      "workspace_read",
      "workspace_write",
      "save_pdf",
      "memory_read",
      "memory_write",
      "ask_user",
      "email_owner",
      "send_email",
    ],
    capUsd: 10,
    files: [
      {
        path: "offer-template.md",
        content: [
          "# OFFER",
          "",
          "**From:** YOUR COMPANY — replace this line in this file with your real details",
          "**To:** {customer name and address}",
          "**Date:** {date}",
          "**Offer no:** {number}",
          "",
          "---",
          "",
          "| Description | Qty | Price | Total |",
          "|---|---|---|---|",
          "| {what the work is} | {n} | {unit price} | {line total} |",
          "",
          "**Total: {total} €**",
          "",
          "Valid for 30 days. Payment within 14 days of invoice.",
          "",
          "---",
          "",
          "Replace every {placeholder} with real values. Keep this structure exactly.",
        ].join("\n"),
      },
    ],
  },
  {
    // Backed by the same live path Max exercises daily: workspace_read against
    // owner-uploaded files (the Files panel + template-following were P2/P3 verified).
    key: "document-answerer",
    name: "Nora",
    role: "Answers questions about your documents",
    avatar: "av-23",
    blurb:
      "Drop contracts, policies or notes into its files, and ask in plain words: what does it " +
      "say about notice periods? It answers from the documents, not from imagination.",
    needs: ["Files — it can only read what you put in its folder"],
    instructions: [
      "You answer questions about the documents in your files.",
      "",
      "When asked something, list your files, read the relevant ones, and answer from what",
      "they actually say — quote the exact passage your answer rests on, and name the file",
      "it came from.",
      "",
      "If the documents do not answer the question, say exactly that. Never fill a gap with",
      "general knowledge without saying clearly that it is not from the documents.",
      "",
      "Keep a note in your memory of which documents you hold and what each covers, so",
      "repeat questions get faster.",
    ].join("\n"),
    tools: ["workspace_list", "workspace_read", "memory_read", "memory_write"],
    capUsd: 5,
  },
  {
    // Backed by: web_fetch live-verified 2026-08-11, schedules live-verified P3, and
    // email_owner live-verified P3 — the three legs this recipe stands on.
    key: "morning-brief",
    name: "Piet",
    role: "Your morning web brief",
    avatar: "av-31",
    blurb:
      "Give it the pages you check every day — news, prices, a status page. Every morning it " +
      "reads them and emails you one short summary.",
    needs: [
      "Read web pages — the brief is read from the addresses you give it",
      "Email you — that is how the brief arrives",
      // Learned the hard way from the withdrawn flight recipe: say this on the CARD, not
      // after someone has adopted it. The difference that makes this one shippable is
      // that it promises to read the pages YOU list and reports honestly when one refuses
      // — it does not promise a particular site's data.
      "Works with pages that allow automated reading — news, reference and publisher sites are fine; some large sites refuse, and it will tell you which",
    ],
    instructions: [
      "You prepare a short morning brief for your owner.",
      "",
      "The pages to read are listed in pages.md in your files — your owner edits that file",
      "to change what you watch. Read each address with your web tool.",
      "",
      "Write ONE email: a plain-language summary of what is new or worth knowing, grouped by",
      "page, with the address after each item so your owner can read more. Three lines per",
      "page at most — this is a brief, not a report.",
      "",
      "If a page could not be read, say so in one line rather than guessing at its contents.",
      "Remember yesterday's headlines in your memory, so you can say what is actually new.",
    ].join("\n"),
    tools: ["web_fetch", "workspace_list", "workspace_read", "memory_read", "memory_write", "email_owner"],
    capUsd: 5,
    maxTokensPerRun: 80_000,
    schedule: {
      kind: "daily",
      hour: 7,
      minute: 30,
      weekday: 1,
      task: "Read the pages listed in pages.md and email your owner the morning brief.",
    },
    files: [
      {
        path: "pages.md",
        content: [
          "# Pages for my morning brief",
          "",
          "One address per line. Replace these examples with the pages you actually check:",
          "",
          "- https://news.ycombinator.com",
          "- https://en.wikipedia.org/wiki/Portal:Current_events",
        ].join("\n"),
      },
    ],
  },
];
