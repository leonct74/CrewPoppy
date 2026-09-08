// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The Crew Pack (DESIGN.md §3b; §18 G3c, and "one product with the live app" step 2): everything
 * the crew learned, as one file the user owns — in the SHARED format both editions read
 * (shared/src/pack.ts). Agents are data — the definition, the notes an agent kept, its files — so
 * the whole crew leaves as JSON and comes back anywhere: after a teardown, on another machine, in
 * the AWS edition. Runs are history, not knowledge; they stay where they were made.
 *
 * This edition's edge: its tool names become the live app's on the way out and are mapped back on
 * the way in, with the abilities not on Google yet said, never dropped in silence; a tier is the
 * pack's model class; a schedule is written on the owner's clock in the live app's shape.
 *
 * The honest note travels with it: nothing here is a credential. A pack carries no token, no key,
 * no receipt — the memory it reads belongs to the user's memory poppy, not to the crew.
 */
import { type CrewPack, PACK_FILENAME, PACK_FORMAT, PACK_VERSION, type PackAgent, type PackFile, type PackNote, type PackSchedule, isPackModel, readCrewPack } from "../../../shared/src/pack";
import { type AgentDef, type AgentInput, agentFrom, validateAgent } from "./agents";
import type { Schedule } from "./schedule";
import type { FileRecord, NoteRecord } from "./store";
import { liveToolNameOf, mapLiveTools } from "./templates";
import { TOOL_LIMITS, isNoteKey, isSafeRelativePath } from "./tools";

export { PACK_FILENAME, PACK_FORMAT, PACK_VERSION };
export type { CrewPack };

export interface PackStore {
  agents(): Promise<AgentDef[]>;
  agent(id: string): Promise<AgentDef | null>;
  saveAgent(a: AgentDef): Promise<void>;
  notes(agentId?: string): Promise<NoteRecord[]>;
  saveNote(n: NoteRecord): Promise<void>;
  files(agentId?: string): Promise<FileRecord[]>;
  saveFile(f: FileRecord): Promise<void>;
}

const KIND = { hour: "hourly", day: "daily", week: "weekly" } as const;
const EVERY = { hourly: "hour", daily: "day", weekly: "week" } as const;
const pad = (n: number): string => String(n).padStart(2, "0");

/** This edition's schedule in the live app's shape. */
export function toPackSchedule(s: Schedule): PackSchedule {
  const [H, M] = s.at.split(":").map(Number) as [number, number];
  const hourly = s.every === "hour";
  return { kind: KIND[s.every], hour: hourly ? 0 : H, minute: hourly ? 0 : M, weekday: s.weekday ?? 1, timezone: s.timeZone, task: s.task ?? "", enabled: true };
}

/** A pack's schedule as this edition's form would receive it; null when there is none to set. */
export function fromPackSchedule(p: unknown, timeZone: string): Record<string, unknown> | null {
  if (!p || typeof p !== "object") return null;
  const s = p as Partial<PackSchedule>;
  if (s.enabled === false) return null;
  const every = s.kind && s.kind in EVERY ? EVERY[s.kind] : "day";
  return {
    every,
    at: every === "hour" ? "00:00" : `${pad(Number(s.hour ?? 9))}:${pad(Number(s.minute ?? 0))}`,
    ...(every === "week" ? { weekday: s.weekday ?? 1 } : {}),
    timeZone: typeof s.timezone === "string" && s.timezone ? s.timezone : timeZone,
    ...(typeof s.task === "string" && s.task.trim() ? { task: s.task } : {}),
  };
}

/** One of this edition's agents as the pack carries it — the live app's tool names, the tier as the model class. */
export function toPackAgent(a: AgentDef): PackAgent {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    instructions: a.instructions,
    tools: (a.tools ?? []).map(liveToolNameOf),
    capUsd: a.capUsd,
    model: isPackModel(a.tier) ? a.tier : "auto",
    memory: a.memory,
    ...(a.schedule ? { schedule: toPackSchedule(a.schedule) } : {}),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export async function buildPack(store: PackStore, now: string, poppy: string): Promise<CrewPack> {
  const [agents, notes, files] = await Promise.all([store.agents(), store.notes(), store.files()]);
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt: now,
    edition: "google",
    poppy,
    agents: agents.map(toPackAgent),
    notes: notes.map((n): PackNote => ({ agent: n.agent, key: n.key, value: n.value, updatedAt: n.updatedAt })),
    files: files.map((f): PackFile => ({ agent: f.agent, path: f.path, content: f.content, updatedAt: f.updatedAt })),
  };
}

/** A version-1 pack — this edition's own shape, before the shared format — read as the shared one. */
function fromLegacyAgent(raw: unknown): PackAgent {
  const a = (raw ?? {}) as Partial<AgentDef> & { schedule?: Partial<Schedule> };
  const schedule = a.schedule && typeof a.schedule === "object" && typeof a.schedule.every === "string" ? toPackSchedule({ every: a.schedule.every, at: a.schedule.at ?? "09:00", weekday: a.schedule.weekday, timeZone: a.schedule.timeZone ?? "UTC", task: a.schedule.task }) : undefined;
  return {
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    role: String(a.role ?? ""),
    instructions: String(a.instructions ?? ""),
    tools: Array.isArray(a.tools) ? a.tools.map((t) => liveToolNameOf(t)) : [],
    capUsd: Number(a.capUsd ?? 5),
    ...(isPackModel(a.tier) ? { model: a.tier } : {}),
    ...(typeof a.memory === "boolean" ? { memory: a.memory } : {}),
    ...(schedule ? { schedule } : {}),
  };
}

/** A pack someone hands us: the envelope checked (shared), a version-1 pack of this edition converted. */
export function readPack(input: unknown): { pack: CrewPack } | { error: string } {
  const read = readCrewPack(input);
  if ("error" in read) return read;
  if (read.pack.version === 1) return { pack: { ...read.pack, version: PACK_VERSION, edition: "google", agents: (read.pack.agents as unknown[]).map(fromLegacyAgent) } };
  return read;
}

export interface PackReport {
  agents: { added: number; updated: number };
  notes: number;
  files: number;
  /** What was left out, and why — in the user's words. */
  skipped: string[];
}

/**
 * Bring a pack in: each agent validated as if typed into the form (an agent with the same id is
 * updated, keeping its birth date; the pack's schedule is the agent's), the abilities not on
 * Google yet said, notes and files kept only for agents that exist afterwards and only under
 * names the tools would accept. Nothing in a pack can name a location.
 */
export async function applyPack(store: PackStore, pack: CrewPack, now: string, reserved: ReadonlySet<string>, timeZone: string): Promise<PackReport> {
  const report: PackReport = { agents: { added: 0, updated: 0 }, notes: 0, files: 0, skipped: [] };
  const taken = new Set([...(await store.agents()).map((a) => a.id), ...reserved]);
  const kept = new Set<string>();
  for (const raw of pack.agents) {
    const p = (raw ?? {}) as Partial<PackAgent>;
    const name = (typeof p.name === "string" && p.name.trim()) || "(unnamed)";
    const mapped = mapLiveTools(Array.isArray(p.tools) ? p.tools : []);
    if (mapped.unknown.length > 0) {
      report.skipped.push(`${name}: no tool is called "${mapped.unknown[0]}" — the catalogue is fixed`);
      continue;
    }
    const input: AgentInput = {
      ...(typeof p.id === "string" && p.id ? { id: p.id } : {}),
      name: p.name,
      role: p.role,
      instructions: p.instructions,
      tier: isPackModel(p.model) ? p.model : "auto",
      ...(typeof p.memory === "boolean" ? { memory: p.memory } : {}),
      ...(p.capUsd !== undefined ? { capUsd: p.capUsd } : {}),
      tools: mapped.tools,
      schedule: fromPackSchedule(p.schedule, timeZone),
    };
    const problems = validateAgent(input, timeZone);
    if (problems.length > 0) {
      report.skipped.push(`${name}: ${problems.join("; ")}`);
      continue;
    }
    if (typeof input.id === "string" && reserved.has(input.id)) {
      report.skipped.push(`${name}: "${input.id}" is one of the crew's own names`);
      continue;
    }
    const existing = typeof input.id === "string" ? await store.agent(input.id) : null;
    const agent = agentFrom(input, existing, now, taken, timeZone);
    await store.saveAgent(agent);
    taken.add(agent.id);
    kept.add(agent.id);
    if (existing) report.agents.updated += 1;
    else report.agents.added += 1;
    if (mapped.notYet.length > 0) report.skipped.push(`${agent.name}'s ${mapped.notYet.join(", ")} — not on Google yet`);
  }
  for (const raw of pack.notes) {
    const n = (raw ?? {}) as Partial<PackNote>;
    if (typeof n.agent !== "string" || !kept.has(n.agent)) continue;
    if (!isNoteKey(n.key) || typeof n.value !== "string" || n.value.length > TOOL_LIMITS.noteValue) {
      report.skipped.push(`a note of ${n.agent} ("${String(n.key ?? "").slice(0, 40)}") — not a note the tools would keep`);
      continue;
    }
    await store.saveNote({ agent: n.agent, key: n.key.trim(), value: n.value, updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : now });
    report.notes += 1;
  }
  for (const raw of pack.files) {
    const f = (raw ?? {}) as Partial<PackFile>;
    if (typeof f.agent !== "string" || !kept.has(f.agent)) continue;
    if (f.encoding === "base64") {
      report.skipped.push(`a file of ${f.agent} ("${String(f.path ?? "").slice(0, 60)}") — a binary file, which this edition does not keep`);
      continue;
    }
    if (!isSafeRelativePath(f.path) || typeof f.content !== "string" || f.content.length > TOOL_LIMITS.fileChars) {
      report.skipped.push(`a file of ${f.agent} ("${String(f.path ?? "").slice(0, 60)}") — not a file the tools would keep`);
      continue;
    }
    await store.saveFile({ agent: f.agent, path: f.path.trim(), content: f.content, updatedAt: typeof f.updatedAt === "string" ? f.updatedAt : now });
    report.files += 1;
  }
  return report;
}

/** "3 agents (1 new, 2 updated), 4 notes and 2 files brought in; 1 left out." */
export function describePackReport(r: PackReport): string {
  const agents = r.agents.added + r.agents.updated;
  const parts = [`${agents} ${agents === 1 ? "agent" : "agents"}${agents ? ` (${r.agents.added} new, ${r.agents.updated} updated)` : ""}`, `${r.notes} ${r.notes === 1 ? "note" : "notes"}`, `${r.files} ${r.files === 1 ? "file" : "files"}`];
  return `${parts.join(", ")} brought in${r.skipped.length ? `; ${r.skipped.length} left out` : ""}.`;
}
