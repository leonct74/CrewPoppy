// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The routes the Crew HQ page calls through the host bridge. `/brief` is the Briefer at work:
 * one search of the memory poppy through the HOST — the week ahead and the month behind, narrowed
 * to our grant, written on the connection's Activity as a receipt — then the people those meetings
 * link to, then the brief,
 * saved in our own project. Nothing here holds memory; the receipt ids come back with the brief
 * so the page can point at them.
 */
import type { Memory, MemoryAvailability, MemoryPage } from "@agentspoppy/core";
import { formatMemoryBytes, memoryBytes } from "@agentspoppy/core";
import { type Brief, writeBrief } from "./briefer";
import { type Caps, DEFAULT_CAPS, type SpendMonth, ceilingUsd, describeMeter, emptyMonth, mayCall, monthOf, recordCall, usd } from "./spend";
import type { BriefRecord, CrewStore, Settings } from "./store";
import type { Model } from "./vertex";

export const PURPOSE = "Morning briefing";
/** The most words the model may write for one brief. */
const BRIEF_MAX_OUTPUT_TOKENS = 400;
/** A brief's material rarely passes this; the ceiling on the receipt is computed from it. */
const BRIEF_PROMPT_TOKENS_ESTIMATE = 1_500;

/** The Briefer's instructions to the model — the material is the whole truth, the model only the pen. */
export const BRIEFER_INSTRUCTIONS = [
  "You are the Briefer, one member of the user's own crew. Write the user's brief from the MATERIAL below and from nothing else.",
  "Never add a fact, a name, a time, a place or a number that is not in the material; never guess what a meeting is about.",
  "If the material says there is nothing on the calendar, say so warmly in one or two sentences.",
  "Plain words, second person, at most 120 words, no headings, no bullet symbols, no emojis. Keep the greeting the material opens with. British spelling.",
].join(" ");
/** The week ahead, and the month behind: a brief is the day's plan with its recent context. */
const AHEAD_DAYS = 7;
const BEHIND_DAYS = 30;
const MAX_EVENTS = 40;

export interface Reply {
  status: number;
  body: unknown;
}
const json = (status: number, body: unknown): Reply => ({ status, body });

/** Where the memories go next, for the receipt (memory-contract §7: "to Claude on Vertex AI, about €0.002"). */
export interface ReceiptHints {
  model?: string;
  estimatedCost?: string;
}

/** The two memory calls the Briefer makes — the client's shape, so a test can hand in a fake. */
export interface MemoryReader {
  status(): Promise<MemoryAvailability>;
  search(req: { purpose: string; kinds: Array<"event" | "person">; since: string; until: string; limit: number } & ReceiptHints): Promise<MemoryPage>;
  get(req: { purpose: string; ids: string[] } & ReceiptHints): Promise<MemoryPage>;
}

export interface RouteDeps {
  store: CrewStore;
  /** Null when the bootstrap carries no memoryUrl — the manifest would be wrong, and the page says so. */
  memory: MemoryReader | null;
  /** Null when the build has no model (G1); Vertex AI in G2. */
  model?: Model | null;
  caps?: Caps;
  now?: () => string;
  timeZone?: () => string;
  newId?: () => string;
  log?: (line: string) => void;
}

/** What the page shows about the model: whether there is one, whether it is on, and the meter. */
async function modelState(deps: RouteDeps, now: string): Promise<{ available: boolean; enabled: boolean; name: string; words: string; meter: string; caps: Caps }> {
  const caps = deps.caps ?? DEFAULT_CAPS;
  if (!deps.model) return { available: false, enabled: false, name: "", words: "", meter: "", caps };
  let enabled = true;
  let spend: SpendMonth = emptyMonth(monthOf(now));
  if (deps.store.ready) {
    const settings = await deps.store.getMeta<Settings>("settings").catch(() => null);
    enabled = settings?.model !== false;
    spend = (await deps.store.spend<SpendMonth>(monthOf(now)).catch(() => null)) ?? spend;
  }
  return { available: true, enabled, name: deps.model.name, words: deps.model.words, meter: describeMeter(spend, caps), caps };
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
    return json(200, { ok: true, cloud: deps.store.state(), memory, memoryWired: deps.memory !== null, briefs, purpose: PURPOSE, model: await modelState(deps, now()) });
  }
  if (!deps.store.ready) return json(503, { ok: false, error: "not_ready", message: deps.store.unavailableMessage() });

  if (method === "POST" && path === "/settings") {
    const b = (body ?? {}) as { model?: unknown };
    if (typeof b.model !== "boolean") return json(400, { ok: false, error: "bad_request", message: "model must be true or false" });
    const current = (await deps.store.getMeta<Settings>("settings")) ?? {};
    await deps.store.setMeta("settings", { ...current, model: b.model });
    return json(200, { ok: true, model: await modelState(deps, now()) });
  }

  if (method === "POST" && path === "/brief") {
    if (!deps.memory) return json(501, { ok: false, error: "no_memory_route", message: "This build has no door to your memory — its manifest must declare permissionSet.memory.reads." });
    const at = now();
    const t = Date.parse(at);
    const since = new Date(t - BEHIND_DAYS * 86_400_000).toISOString();
    const until = new Date(t + AHEAD_DAYS * 86_400_000).toISOString();
    // Where the memories go next: to the model, when there is one and it is on — the receipt says so.
    const settings = (await deps.store.getMeta<Settings>("settings").catch(() => null)) ?? {};
    const useModel = !!deps.model && settings.model !== false;
    const hints: ReceiptHints = useModel && deps.model ? { model: deps.model.words, estimatedCost: usd(ceilingUsd(BRIEF_PROMPT_TOKENS_ESTIMATE + BRIEF_MAX_OUTPUT_TOKENS)) } : {};
    let page: MemoryPage;
    try {
      page = await deps.memory.search({ purpose: PURPOSE, kinds: ["event"], since, until, limit: MAX_EVENTS, ...hints });
    } catch (e) {
      return json(502, { ok: false, error: "memory_read_failed", message: plain(e) });
    }
    const events: Memory[] = page.memories.filter((m) => m.kind === "event");
    const receipts: string[] = page.receipt ? [page.receipt] : [];
    let people: Memory[] = [];
    const personIds = [...new Set(events.flatMap((e) => (e.links ?? []).filter((l) => l.relation === "with").map((l) => l.to)))];
    if (personIds.length > 0) {
      try {
        const got = await deps.memory.get({ purpose: PURPOSE, ids: personIds.slice(0, 100), ...hints });
        people = got.memories.filter((m) => m.kind === "person");
        if (got.receipt) receipts.push(got.receipt);
      } catch (e) {
        deps.log?.(`the people of the meetings could not be read: ${plain(e)}`);
      }
    }
    // The Briefer's own words are the material — and the brief itself when the model is off, capped, or away.
    const brief: Brief = writeBrief({ events, people, now: at, timeZone: timeZone() });
    let text = brief.text;
    let writtenBy: BriefRecord["writtenBy"] = "template";
    let modelUsed: BriefRecord["model"] | undefined;
    let note: string | undefined;
    if (useModel && deps.model) {
      const caps = deps.caps ?? DEFAULT_CAPS;
      const month = monthOf(at);
      const spend = (await deps.store.spend<SpendMonth>(month).catch(() => null)) ?? emptyMonth(month);
      const allowed = mayCall(spend, caps, at);
      if (!allowed.ok) {
        note = `The Briefer wrote this itself: ${allowed.reason}.`;
      } else {
        try {
          const reply = await deps.model.generate(BRIEFER_INSTRUCTIONS, `MATERIAL:\n${brief.text}`, BRIEF_MAX_OUTPUT_TOKENS);
          text = reply.text;
          writtenBy = "model";
          modelUsed = { name: reply.model, words: deps.model.words, promptTokens: reply.promptTokens, outputTokens: reply.outputTokens, ceilingUsd: ceilingUsd(reply.promptTokens + reply.outputTokens) };
          await deps.store.saveSpend(month, recordCall(spend, reply.promptTokens, reply.outputTokens, at));
        } catch (e) {
          note = `The Briefer wrote this itself — ${plain(e)}`;
          deps.log?.(`model call failed, template used: ${plain(e)}`);
        }
      }
    }
    const record: BriefRecord = {
      id: (deps.newId ?? defaultId)(),
      at,
      purpose: PURPOSE,
      text,
      memoryIds: brief.memoryIds,
      receipts,
      read: { events: events.length, people: people.length, bytes: [...events, ...people].reduce((n, m) => n + memoryBytes(m), 0) },
      writtenBy,
      ...(modelUsed ? { model: modelUsed } : {}),
      ...(note ? { note } : {}),
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
