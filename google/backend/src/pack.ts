// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The Crew Pack (DESIGN.md §3b; §18 G3c): everything the crew learned, as one file the user owns.
 * Agents are data — the definition, the notes an agent kept, its files — so the whole crew leaves
 * as JSON and comes back anywhere: after a teardown, on another machine, in the AWS edition one
 * day. Runs and briefs are history, not knowledge; they stay where they were made.
 *
 * The honest note travels with it: nothing here is a credential. A pack carries no token, no key,
 * no receipt — the memory it reads belongs to the user's memory poppy, not to the crew.
 */
import { type AgentDef, type AgentInput, agentFrom, validateAgent } from "./agents";
import type { FileRecord, NoteRecord } from "./store";
import { TOOL_LIMITS, isNoteKey, isSafeRelativePath } from "./tools";

export const PACK_FORMAT = "crewpoppy-crew-pack";
export const PACK_VERSION = 1;
export const PACK_FILENAME = "crewpoppy-crew-pack.json";
const MAX_AGENTS = 100;
const MAX_ITEMS = 2_000;

export interface CrewPack {
  format: typeof PACK_FORMAT;
  version: number;
  exportedAt: string;
  edition: "google";
  poppy: string;
  agents: AgentDef[];
  notes: NoteRecord[];
  files: FileRecord[];
}

export interface PackStore {
  agents(): Promise<AgentDef[]>;
  agent(id: string): Promise<AgentDef | null>;
  saveAgent(a: AgentDef): Promise<void>;
  notes(agentId?: string): Promise<NoteRecord[]>;
  saveNote(n: NoteRecord): Promise<void>;
  files(agentId?: string): Promise<FileRecord[]>;
  saveFile(f: FileRecord): Promise<void>;
}

export async function buildPack(store: PackStore, now: string, poppy: string): Promise<CrewPack> {
  const [agents, notes, files] = await Promise.all([store.agents(), store.notes(), store.files()]);
  return { format: PACK_FORMAT, version: PACK_VERSION, exportedAt: now, edition: "google", poppy, agents, notes, files };
}

/** A pack someone hands us: checked before anything of it is kept. */
export function readPack(input: unknown): { pack: CrewPack } | { error: string } {
  if (!input || typeof input !== "object") return { error: "That is not a Crew Pack — expected a JSON object." };
  const p = input as Record<string, unknown>;
  if (p.format !== PACK_FORMAT) return { error: `That is not a Crew Pack — its format is "${String(p.format ?? "missing").slice(0, 40)}".` };
  if (typeof p.version !== "number" || p.version > PACK_VERSION) return { error: `This Crew Pack is version ${String(p.version)}; this CrewPoppy reads up to version ${PACK_VERSION}. Update CrewPoppy first.` };
  const agents = Array.isArray(p.agents) ? p.agents : [];
  const notes = Array.isArray(p.notes) ? p.notes : [];
  const files = Array.isArray(p.files) ? p.files : [];
  if (agents.length > MAX_AGENTS) return { error: `That pack holds ${agents.length} agents — the most a crew can take is ${MAX_AGENTS}.` };
  if (notes.length + files.length > MAX_ITEMS) return { error: `That pack holds ${notes.length + files.length} notes and files — more than ${MAX_ITEMS}.` };
  return { pack: { format: PACK_FORMAT, version: p.version, exportedAt: typeof p.exportedAt === "string" ? p.exportedAt : "", edition: "google", poppy: typeof p.poppy === "string" ? p.poppy : "", agents: agents as AgentDef[], notes: notes as NoteRecord[], files: files as FileRecord[] } };
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
 * updated, keeping its birth date), notes and files kept only for agents that exist afterwards,
 * and only under names the tools would accept. Nothing in a pack can name a location.
 */
export async function applyPack(store: PackStore, pack: CrewPack, now: string, reserved: ReadonlySet<string>, timeZone: string): Promise<PackReport> {
  const report: PackReport = { agents: { added: 0, updated: 0 }, notes: 0, files: 0, skipped: [] };
  const taken = new Set([...(await store.agents()).map((a) => a.id), ...reserved]);
  const kept = new Set<string>();
  for (const raw of pack.agents) {
    const input = (raw ?? {}) as AgentInput;
    const name = (typeof input.name === "string" && input.name.trim()) || "(unnamed)";
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
  }
  for (const raw of pack.notes) {
    const n = (raw ?? {}) as Partial<NoteRecord>;
    if (typeof n.agent !== "string" || !kept.has(n.agent)) continue;
    if (!isNoteKey(n.key) || typeof n.value !== "string" || n.value.length > TOOL_LIMITS.noteValue) {
      report.skipped.push(`a note of ${n.agent} ("${String(n.key ?? "").slice(0, 40)}") — not a note the tools would keep`);
      continue;
    }
    await store.saveNote({ agent: n.agent, key: n.key.trim(), value: n.value, updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : now });
    report.notes += 1;
  }
  for (const raw of pack.files) {
    const f = (raw ?? {}) as Partial<FileRecord>;
    if (typeof f.agent !== "string" || !kept.has(f.agent)) continue;
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
