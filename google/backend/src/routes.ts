// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The routes the Crew HQ page calls through the host bridge. `/brief` is the Briefer at work:
 * one search of the memory poppy through the HOST — the week ahead and the month behind, narrowed
 * to our grant, written on the connection's Activity as a receipt — then the people those meetings
 * link to, then the brief, saved in our own project. `/ask` and `/agents/:id/run` go through the
 * runner (G3); `/runs/:id/answer` resumes a run that asked you (G3c); the Crew Pack leaves and
 * comes back as one file. Nothing here holds memory; receipt ids come back so the page can point.
 */
import type { Memory, MemoryAvailability, MemoryPage } from "@agentspoppy/core";
import { formatMemoryBytes, memoryBytes } from "@agentspoppy/core";
import { randomBytes } from "node:crypto";
import { AGENT_LIMITS, agentFrom, idFor, validateAgent } from "./agents";
import { type Brief, writeBrief } from "./briefer";
import type { MemoryReader, ReceiptHints } from "./memory-reader";
import { PACK_FILENAME, applyPack, buildPack, describePackReport, readPack } from "./pack";
import { ASSISTANT, BRIEFER_ID, type TierChoice } from "./planner";
import { ASK_MAX_CHARS, type RunDeps, askCrew, describePlan, resumeRun, runAgent } from "./runner";
import { describeSchedule, nextDue } from "./schedule";
import { DEFAULT_CAPS, type Caps, type SpendMonth, agentSpent, ceilingUsd, describeMeter, emptyMonth, mayCall, monthOf, recordCall, usd } from "./spend";
import type { BriefRecord, RunRecord, Settings } from "./store";
import { TOOL_GROUPS, TOOL_NOTES } from "./tools";

export type { MemoryReader, ReceiptHints } from "./memory-reader";
export type { RunDeps as RouteDeps } from "./runner";
export { describePlan } from "./runner";

export const POPPY_ID = "com.crewpoppy.cloud.google";
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
  /** Set for a download: the body is the file's text, sent as is. */
  contentType?: string;
  filename?: string;
}
const json = (status: number, body: unknown): Reply => ({ status, body });

/** The crew as the page shows it: the pre-built members. */
export const CREW = [
  { id: BRIEFER_ID, name: "The Briefer", role: "reads your memory, writes your brief", tier: "standard" as const },
  { id: ASSISTANT.id, name: ASSISTANT.name, role: ASSISTANT.role, tier: "auto" as const },
];

/** One-shot download tokens: the host's browser fetches `/local-download/<token>` exactly once. */
const downloads = new Map<string, { expiresAt: number }>();
const DOWNLOAD_TTL_MS = 5 * 60 * 1000;

/** What the page shows about the model: whether there is one, whether it is on, and the meter. */
async function modelState(deps: RunDeps, now: string): Promise<{ available: boolean; enabled: boolean; name: string; words: string; meter: string; caps: Caps }> {
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

export async function handle(path: string, method: string, body: unknown, deps: RunDeps): Promise<Reply> {
  const now = deps.now ?? (() => new Date().toISOString());
  const timeZone = deps.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");

  if (method === "GET" && (path === "/" || path === "/health")) {
    return json(200, { ok: true, poppy: POPPY_ID, cloud: deps.store.state() });
  }
  if (method === "GET" && path === "/state") {
    let memory: MemoryAvailability | { available: false; error: string } | null = null;
    if (deps.memory) {
      try {
        memory = await deps.memory.status();
      } catch (e) {
        memory = { available: false, error: plain(e) };
      }
    }
    let briefs: BriefRecord[] = [];
    let runs: RunRecord[] = [];
    let waiting: RunRecord[] = [];
    if (deps.store.ready) {
      try {
        [briefs, runs, waiting] = await Promise.all([deps.store.briefs(10), deps.store.runs(10), deps.store.waiting()]);
      } catch (e) {
        deps.log?.(`could not list the records: ${plain(e)}`);
      }
    }
    return json(200, { ok: true, cloud: deps.store.state(), memory, memoryWired: deps.memory !== null, briefs, runs: runs.map(publicRun), waiting: waiting.map(publicRun), crew: CREW, purpose: PURPOSE, model: await modelState(deps, now()), tools: { groups: TOOL_GROUPS, notes: TOOL_NOTES }, timeZone: timeZone() });
  }
  if (!deps.store.ready) return json(503, { ok: false, error: "not_ready", message: deps.store.unavailableMessage() });

  // The page just opened: what the cloud job did while the app was closed (G4), since the last open.
  if (method === "POST" && path === "/opened") {
    const at = now();
    const last = (await deps.store.getMeta<{ at?: string }>("lastOpen").catch(() => null))?.at ?? "";
    const runs = await deps.store.runs(200);
    const away = runs.filter((r) => r.via === "cloud" && r.at > last).map(publicRun);
    await deps.store.setMeta("lastOpen", { at }).catch((e) => deps.log?.(`could not note the open: ${plain(e)}`));
    return json(200, { ok: true, since: last, away });
  }

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
  if (method === "GET" && path === "/history") {
    const [briefs, runs] = await Promise.all([deps.store.briefs(30), deps.store.runs(30)]);
    return json(200, { ok: true, briefs, runs: runs.map(publicRun) });
  }

  // ---- Ask your crew: the Planner routes a task on the fly (G3) ---------------------------------
  if (method === "POST" && path === "/ask") {
    const b = (body ?? {}) as { request?: unknown; choice?: unknown };
    const request = typeof b.request === "string" ? b.request.trim() : "";
    if (!request) return json(400, { ok: false, error: "bad_request", message: "Ask something — a request in your own words." });
    if (request.length > ASK_MAX_CHARS) return json(400, { ok: false, error: "bad_request", message: `That is more than ${ASK_MAX_CHARS.toLocaleString("en-GB")} characters — shorten it, or paste the long part into a file for a later release.` });
    const choice: TierChoice = b.choice === "quick" || b.choice === "standard" || b.choice === "best" ? b.choice : "auto";
    const { run, planLine } = await askCrew(deps, request, choice);
    return json(200, { ok: true, run: publicRun(run), planLine });
  }

  // ---- A run that asked you (G3c) ---------------------------------------------------------------
  const runMatch = /^\/runs\/([A-Za-z0-9~_-]+)\/(answer|stop)$/.exec(path);
  if (method === "POST" && runMatch) {
    const [, id, action] = runMatch as unknown as [string, string, "answer" | "stop"];
    const run = await deps.store.run(id);
    if (!run) return json(404, { ok: false, error: "not_found", message: "That run is not in your history." });
    if (run.status !== "waiting") return json(409, { ok: false, error: "not_waiting", message: "That run is not waiting for an answer." });
    if (action === "stop") {
      const stopped: RunRecord = { ...run, status: "stopped", note: "You stopped this run.", answeredAt: now() };
      delete stopped.conversation;
      delete stopped.question;
      await deps.store.saveRun(stopped);
      return json(200, { ok: true, run: publicRun(stopped) });
    }
    const b = (body ?? {}) as { answer?: unknown };
    const answer = typeof b.answer === "string" ? b.answer.trim() : "";
    if (!answer) return json(400, { ok: false, error: "bad_request", message: "Write an answer — a word is enough." });
    if (answer.length > AGENT_LIMITS.request) return json(400, { ok: false, error: "bad_request", message: `That is more than ${AGENT_LIMITS.request.toLocaleString("en-GB")} characters.` });
    const r = await resumeRun(deps, run, answer);
    return json(200, r.ok ? { ...r, run: publicRun(r.run) } : r);
  }

  // ---- Your own agents (G3b) --------------------------------------------------------------------
  if (method === "GET" && path === "/agents") {
    const [agents, spend] = await Promise.all([deps.store.agents(), deps.store.spend<SpendMonth>(monthOf(now())).catch(() => null)]);
    const at = now();
    return json(200, { ok: true, agents: agents.map((a) => ({ ...a, monthUsd: spend ? agentSpent(spend, a.id) : 0, scheduleLine: a.schedule ? describeSchedule(a.schedule) : "", nextRunAt: a.schedule ? nextDue(a.schedule, at) : "" })), builtIn: CREW });
  }
  if (method === "POST" && path === "/agents") {
    const input = (body ?? {}) as Record<string, unknown>;
    const problems = validateAgent(input, timeZone());
    if (problems.length > 0) return json(400, { ok: false, error: "bad_request", message: problems.join("; "), problems });
    const existing = typeof input.id === "string" ? await deps.store.agent(input.id) : null;
    const taken = new Set([...(await deps.store.agents()).map((a) => a.id), ...CREW.map((c) => c.id)]);
    // The crew's own names stay the crew's: no "Assistant" or "Briefer" of the user's beside them.
    if (!existing && CREW.some((c) => c.id === idFor(String(input.name ?? ""), new Set()))) {
      return json(409, { ok: false, error: "taken", message: `"${String(input.name).trim()}" is one of the crew's own names — pick another` });
    }
    const agent = agentFrom(input, existing, now(), taken, timeZone());
    await deps.store.saveAgent(agent);
    return json(200, { ok: true, agent: { ...agent, scheduleLine: agent.schedule ? describeSchedule(agent.schedule) : "", nextRunAt: agent.schedule ? nextDue(agent.schedule, now()) : "" } });
  }
  const agentMatch = /^\/agents\/([a-z0-9-]+)\/(run|delete)$/.exec(path);
  if (method === "POST" && agentMatch) {
    const [, id, action] = agentMatch as unknown as [string, string, "run" | "delete"];
    const agent = await deps.store.agent(id);
    if (!agent) return json(404, { ok: false, error: "not_found", message: "That agent is not in your crew." });
    if (action === "delete") {
      await deps.store.deleteAgentData(id);
      await deps.store.deleteAgent(id);
      return json(200, { ok: true });
    }
    const b = (body ?? {}) as { request?: unknown };
    const request = typeof b.request === "string" ? b.request.trim() : "";
    if (request.length > AGENT_LIMITS.request) return json(400, { ok: false, error: "bad_request", message: `That is more than ${AGENT_LIMITS.request.toLocaleString("en-GB")} characters.` });
    if (await deps.store.activeRun(id)) return json(409, { ok: false, error: "busy", message: `${agent.name} is still on a run — answer it under Today, or stop it, first.` });
    const r = await runAgent(deps, agent, request, { trigger: "run" });
    return json(200, r.ok ? { ...r, run: publicRun(r.run) } : r);
  }

  // ---- The Crew Pack (G3c): the crew's knowledge as one file, out and back -----------------------
  if (method === "GET" && path === "/crew-pack") {
    return json(200, await buildPack(deps.store, now(), POPPY_ID));
  }
  if (method === "POST" && path === "/export-token") {
    const token = randomBytes(16).toString("hex");
    downloads.set(token, { expiresAt: Date.now() + DOWNLOAD_TTL_MS });
    return json(200, { ok: true, token, path: `/local-download/${token}`, filename: PACK_FILENAME });
  }
  if (method === "GET" && path.startsWith("/local-download/")) {
    const token = path.slice("/local-download/".length);
    const entry = downloads.get(token);
    downloads.delete(token);
    if (!entry || entry.expiresAt < Date.now()) return json(404, { ok: false, error: "expired", message: "This download link was already used or has expired — ask for a new one." });
    return { status: 200, body: JSON.stringify(await buildPack(deps.store, now(), POPPY_ID), null, 2), contentType: "application/json; charset=utf-8", filename: PACK_FILENAME };
  }
  if (method === "POST" && path === "/crew-pack") {
    const read = readPack((body as { pack?: unknown } | undefined)?.pack ?? body);
    if ("error" in read) return json(400, { ok: false, error: "bad_pack", message: read.error });
    const report = await applyPack(deps.store, read.pack, now(), new Set(CREW.map((c) => c.id)), timeZone());
    return json(200, { ok: true, report, line: describePackReport(report) });
  }

  return json(404, { ok: false, error: "not_found", message: `no route for ${method} ${path}` });
}

/** A run as the page sees it — the paused conversation stays in the store. */
function publicRun(r: RunRecord): Omit<RunRecord, "conversation"> {
  const { conversation: _c, ...rest } = r;
  return rest;
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
