// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The live app's recipes, offered here (DESIGN §18 "One product with the live app", step 1).
 *
 * A template IS the shared catalogue's recipe (shared/src/recipes.ts — one list for both
 * editions, never a copy): this edition maps the recipe's tools to its own and says plainly which
 * abilities are not on Google yet. Activating one makes an ordinary agent — the suggested name,
 * brief, tools, cap, schedule (with its task) and files — that the user edits like any other. A
 * recipe whose core is an ability this edition lacks is shown and not activatable, with the reason.
 */
import { RECIPES, type Recipe, type RecipeSchedule } from "../../../shared/src/recipes";
import type { ToolName as LiveTool } from "../../../shared/src/tools";
import { AGENT_LIMITS, type AgentDef, idFor } from "./agents";
import type { Schedule } from "./schedule";
import type { FileRecord } from "./store";
import { TOOL_NAMES, type ToolName } from "./tools";

/**
 * The live app's tool → this edition's, or the ability's name when this edition lacks it. The
 * live app's "memory" tools are the agent's OWN memory — here, its notes; the user's memory is the
 * `memory` flag, which a template leaves off (nothing in a recipe is about the user's life).
 */
const TOOL_MAP: Record<LiveTool, ToolName | { notYet: string }> = {
  memory_read: "note_read",
  memory_write: "note_write",
  workspace_list: "file_list",
  workspace_read: "file_read",
  workspace_write: "file_write",
  workspace_append: "file_append",
  ask_user: "ask_user",
  save_pdf: { notYet: "PDFs" },
  read_image: { notYet: "reading photos" },
  email_owner: { notYet: "e-mail to you" },
  send_email: { notYet: "e-mail to others" },
  web_fetch: { notYet: "reading web pages" },
};

/** Recipes whose core is an ability this edition lacks: offered as coming, not activatable. */
const CORE_NOT_YET: Record<string, string> = {
  "offer-writer": "its offers are PDFs sent by e-mail",
  "morning-brief": "it reads web pages and e-mails you the brief",
};

/** A schedule as a template suggests it: the owner's clock is added at activation. */
export type TemplateSchedule = Omit<Schedule, "timeZone">;

export interface Template {
  key: string;
  name: string;
  role: string;
  blurb: string;
  needs: string[];
  instructions: string;
  tools: ToolName[];
  memory: boolean;
  capUsd: number;
  schedule?: TemplateSchedule;
  files: Array<{ path: string; content: string }>;
  /** Abilities the recipe uses that this edition lacks, in the user's words. */
  notYet: string[];
  /** Why this template cannot be activated here yet; absent when it can. */
  unavailable?: string;
}

const TWO = (n: number): string => String(n).padStart(2, "0");

/** hourly/daily/weekly at hour:minute → every hour/day/week at "HH:MM" (minutes snapped to five, as this edition's clock is). */
export function scheduleOf(s: RecipeSchedule): TemplateSchedule {
  const every = s.kind === "hourly" ? "hour" : s.kind === "weekly" ? "week" : "day";
  const minute = Math.min(55, Math.round(s.minute / 5) * 5);
  return { every, at: every === "hour" ? "00:00" : `${TWO(s.hour)}:${TWO(minute)}`, ...(every === "week" ? { weekday: s.weekday } : {}), task: s.task };
}

/**
 * The live app's tool names → this edition's, in catalogue order; the abilities this edition lacks
 * named once each; names neither edition knows listed apart. Notes are read and written as a pair
 * here, so a crew that keeps a memory reads it back. Used by the templates and by the Crew Pack.
 */
export function mapLiveTools(tools: readonly unknown[]): { tools: ToolName[]; notYet: string[]; unknown: string[] } {
  const mapped = new Set<ToolName>();
  const notYet: string[] = [];
  const unknown: string[] = [];
  for (const t of tools) {
    const m = typeof t === "string" && t in TOOL_MAP ? TOOL_MAP[t as LiveTool] : undefined;
    if (m === undefined) unknown.push(String(t));
    else if (typeof m === "string") mapped.add(m);
    else if (!notYet.includes(m.notYet)) notYet.push(m.notYet);
  }
  if (mapped.has("note_write")) mapped.add("note_read");
  return { tools: TOOL_NAMES.filter((t) => t !== "memory_search" && mapped.has(t)), notYet, unknown };
}

const LIVE_NAME: Partial<Record<ToolName, LiveTool>> = { note_read: "memory_read", note_write: "memory_write", file_list: "workspace_list", file_read: "workspace_read", file_write: "workspace_write", file_append: "workspace_append", ask_user: "ask_user" };

/** This edition's tool name in the live app's terms — for the Crew Pack, which speaks the live app's. */
export function liveToolNameOf(tool: ToolName): string {
  return LIVE_NAME[tool] ?? tool;
}

function templateOf(r: Recipe): Template {
  const { tools, notYet } = mapLiveTools(r.tools);
  const instructions =
    notYet.length > 0
      ? `${r.instructions.trim()}\n\nNot available in this edition: ${notYet.join(", ")}. When the job calls for one of them, write the result as a file instead and say plainly what you could not do.`
      : r.instructions.trim();
  const unavailable = CORE_NOT_YET[r.key];
  return {
    key: r.key,
    name: r.name,
    role: r.role,
    blurb: r.blurb,
    needs: r.needs,
    instructions: instructions.slice(0, AGENT_LIMITS.instructions),
    tools,
    memory: false,
    capUsd: Math.min(AGENT_LIMITS.capUsdMax, Math.max(AGENT_LIMITS.capUsdMin, Math.round(r.capUsd))),
    ...(r.schedule ? { schedule: scheduleOf(r.schedule) } : {}),
    files: (r.files ?? []).map((f) => ({ path: f.path, content: f.content })),
    notYet,
    ...(unavailable ? { unavailable } : {}),
  };
}

/**
 * This edition's own template: the morning brief from the user's MEMORY poppy — what the Google
 * edition's first step did as a built-in "Briefer" (DESIGN §18 G1). The founder chose the live
 * app's shape on 2026-09-08: no built-in members; the brief is an agent the user activates, with a
 * schedule and a task, and nothing runs until they do.
 */
export const MORNING_BRIEF: Template = {
  key: "morning-brief-memory",
  name: "Bea",
  role: "Your morning brief, from your memory",
  blurb: "Every morning it reads today's meetings and the people in them from your memory poppy, through AgentsPoppy, and writes you a short brief — nothing invented, a receipt for every read.",
  needs: ["Your memory poppy, installed and open to CrewPoppy for people and meetings — every read leaves a receipt on your Activity"],
  instructions: [
    "You write the user's morning brief from the MEMORIES you are given and from what memory_search returns, and from nothing else.",
    "Say what is on today's calendar, who is in each meeting, and anything recent worth remembering about those people.",
    "Never add a fact, a name, a time, a place or a number that is not in the memories; never guess what a meeting is about.",
    "If the memories hold nothing for today, say so warmly in one or two sentences.",
    "Open with a greeting that fits the time of day. Plain words, second person, at most 120 words, no headings, no bullet symbols. British spelling.",
  ].join("\n"),
  tools: [],
  memory: true,
  capUsd: 2,
  schedule: { every: "day", at: "07:30", task: "Write my morning brief: today's meetings, the people in them, and anything recent worth remembering about them." },
  files: [],
  notYet: [],
};

/** The live app's catalogue, as this edition offers it — in the catalogue's own order — then this edition's own. */
export const TEMPLATES: readonly Template[] = [...RECIPES.map(templateOf), MORNING_BRIEF];

export function templateByKey(key: string): Template | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

/** The agent a template becomes, with its files — the owner's clock on the schedule, a fresh id beside the crew's names. */
export function activateTemplate(t: Template, taken: ReadonlySet<string>, now: string, timeZone: string): { agent: AgentDef; files: FileRecord[] } {
  const id = idFor(t.name, taken);
  const agent: AgentDef = {
    id,
    name: t.name,
    role: t.role,
    instructions: t.instructions,
    tier: "auto",
    memory: t.memory,
    capUsd: t.capUsd,
    tools: t.tools,
    ...(t.schedule ? { schedule: { ...t.schedule, timeZone } } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return { agent, files: t.files.map((f) => ({ agent: id, path: f.path, content: f.content, updatedAt: now })) };
}
