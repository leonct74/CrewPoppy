// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The routes the Crew HQ page calls through the host bridge. `/brief` is the Briefer at work:
 * one search of the memory poppy through the HOST — narrowed to our grant, written on the
 * connection's Activity as a receipt — then the people those meetings link to, then the brief,
 * saved in our own project. Nothing here holds memory; the receipt ids come back with the brief
 * so the page can point at them.
 */
import type { Memory, MemoryAvailability, MemoryPage } from "@agentspoppy/core";
import { formatMemoryBytes, memoryBytes } from "@agentspoppy/core";
import { type Brief, writeBrief } from "./briefer";
import type { BriefRecord, CrewStore } from "./store";

export const PURPOSE = "Morning briefing";
const WINDOW_DAYS = 7;
const MAX_EVENTS = 40;

export interface Reply {
  status: number;
  body: unknown;
}
const json = (status: number, body: unknown): Reply => ({ status, body });

/** The two memory calls the Briefer makes — the client's shape, so a test can hand in a fake. */
export interface MemoryReader {
  status(): Promise<MemoryAvailability>;
  search(req: { purpose: string; kinds: Array<"event" | "person">; since: string; until: string; limit: number }): Promise<MemoryPage>;
  get(req: { purpose: string; ids: string[] }): Promise<MemoryPage>;
}

export interface RouteDeps {
  store: CrewStore;
  /** Null when the bootstrap carries no memoryUrl — the manifest would be wrong, and the page says so. */
  memory: MemoryReader | null;
  now?: () => string;
  timeZone?: () => string;
  newId?: () => string;
  log?: (line: string) => void;
}

export async function handle(path: string, method: string, body: unknown, deps: RouteDeps): Promise<Reply> {
  const now = deps.now ?? (() => new Date().toISOString());
  const timeZone = deps.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  void body;

  if (method === "GET" && (path === "/" || path === "/health")) {
    return json(200, { ok: true, poppy: "com.crewpoppy.cloud.google", cloud: deps.store.state() });
  }
  if (method === "GET" && path === "/state") {
    let memory: MemoryAvailability | { available: false; error: string } | null = null;
    if (deps.memory) {
      try {
        memory = await deps.memory.status();
      } catch (e) {
        memory = { available: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    let briefs: BriefRecord[] = [];
    if (deps.store.ready) {
      try {
        briefs = await deps.store.briefs(10);
      } catch (e) {
        deps.log?.(`could not list briefs: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return json(200, { ok: true, cloud: deps.store.state(), memory, memoryWired: deps.memory !== null, briefs, purpose: PURPOSE });
  }
  if (!deps.store.ready) return json(503, { ok: false, error: "not_ready", message: deps.store.unavailableMessage() });

  if (method === "POST" && path === "/brief") {
    if (!deps.memory) return json(501, { ok: false, error: "no_memory_route", message: "This build has no door to your memory — its manifest must declare permissionSet.memory.reads." });
    const at = now();
    const t = Date.parse(at);
    const since = new Date(t - WINDOW_DAYS * 86_400_000).toISOString();
    const until = new Date(t + WINDOW_DAYS * 86_400_000).toISOString();
    let page: MemoryPage;
    try {
      page = await deps.memory.search({ purpose: PURPOSE, kinds: ["event"], since, until, limit: MAX_EVENTS });
    } catch (e) {
      return json(502, { ok: false, error: "memory_read_failed", message: plain(e) });
    }
    const events: Memory[] = page.memories.filter((m) => m.kind === "event");
    const receipts: string[] = page.receipt ? [page.receipt] : [];
    let people: Memory[] = [];
    const personIds = [...new Set(events.flatMap((e) => (e.links ?? []).filter((l) => l.relation === "with").map((l) => l.to)))];
    if (personIds.length > 0) {
      try {
        const got = await deps.memory.get({ purpose: PURPOSE, ids: personIds.slice(0, 100) });
        people = got.memories.filter((m) => m.kind === "person");
        if (got.receipt) receipts.push(got.receipt);
      } catch (e) {
        deps.log?.(`the people of the meetings could not be read: ${plain(e)}`);
      }
    }
    const brief: Brief = writeBrief({ events, people, now: at, timeZone: timeZone() });
    const record: BriefRecord = {
      id: (deps.newId ?? defaultId)(),
      at,
      purpose: PURPOSE,
      text: brief.text,
      memoryIds: brief.memoryIds,
      receipts,
      read: { events: events.length, people: people.length, bytes: [...events, ...people].reduce((n, m) => n + memoryBytes(m), 0) },
    };
    try {
      await deps.store.saveBrief(record);
    } catch (e) {
      return json(503, { ok: false, error: "store_unavailable", message: plain(e) });
    }
    return json(200, { ok: true, brief: record, readLine: describeRead(record), truncated: page.truncated });
  }
  if (method === "GET" && path === "/briefs") {
    return json(200, { ok: true, briefs: await deps.store.briefs(30) });
  }
  return json(404, { ok: false, error: "not_found", message: `no route for ${method} ${path}` });
}

/** "Read 2 meetings and 3 people for “Morning briefing” — 1.2 KB." — the page's line under a brief. */
export function describeRead(b: BriefRecord): string {
  const parts: string[] = [];
  if (b.read.events) parts.push(`${b.read.events} ${b.read.events === 1 ? "meeting" : "meetings"}`);
  if (b.read.people) parts.push(`${b.read.people} ${b.read.people === 1 ? "person" : "people"}`);
  const what = parts.length === 0 ? "nothing" : parts.join(" and ");
  return `Read ${what} for “${b.purpose}” — ${formatMemoryBytes(b.read.bytes)}.`;
}

function defaultId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function plain(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
