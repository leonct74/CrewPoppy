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
import { AGENT_LIMITS, agentFrom, validateAgent } from "./agents";
import type { MemoryReader, ReceiptHints } from "./memory-reader";
import { PACK_FILENAME, applyPack, buildPack, describePackReport, readPack } from "./pack";
import { TIERS, priceLine } from "./planner";
import { type RunDeps, describePlan, resumeRun, runAgent } from "./runner";
import { cronOf, describeSchedule, nextDue } from "./schedule";
import { DEFAULT_CAPS, type Caps, type SpendMonth, agentUsage, ceilingUsd, describeMeter, emptyMonth, listUsd, mayCall, monthOf, recordCall } from "./spend";
import type { RunRecord, Settings } from "./store";
import { TEMPLATES, activateTemplate, templateByKey } from "./templates";
import { TOOL_GROUPS, TOOL_NOTES } from "./tools";

export type { MemoryReader, ReceiptHints } from "./memory-reader";
export type { RunDeps as RouteDeps } from "./runner";
export { describePlan } from "./runner";

export const POPPY_ID = "com.crewpoppy.cloud.google";
export interface Reply {
  status: number;
  body: unknown;
  /** Set for a download: the body is the file's text, sent as is. */
  contentType?: string;
  filename?: string;
}
const json = (status: number, body: unknown): Reply => ({ status, body });

/** One-shot download tokens: the host's browser fetches `/local-download/<token>` exactly once. */
const downloads = new Map<string, { expiresAt: number }>();
const DOWNLOAD_TTL_MS = 5 * 60 * 1000;

/** What the page shows about the model: whether there is one, whether it is on, and the meter. */
/** The tier a model name belongs to — the Briefer's Flash is the standard tier. */
const tierOfModel = (model: string) => Object.values(TIERS).find((t) => t.model === model) ?? TIERS.standard;

/** The money an agent's tile shows: its tokens and their cost at Google's price; the ceiling figure only for its cap. */
function usageOf(spend: SpendMonth | null, a: { id: string; tier: string }): { monthUsd: number; monthTokens: number; monthListUsd: number; price: string } {
  const u = spend ? agentUsage(spend, a.id) : { tokens: 0, listUsd: 0, ceilingUsd: 0 };
  const tier = a.tier === "auto" ? undefined : TIERS[a.tier as keyof typeof TIERS];
  return { monthUsd: u.ceilingUsd, monthTokens: u.tokens, monthListUsd: u.listUsd, price: tier ? priceLine(tier) : "" };
}

/** Google's price per million for each model the crew may use — shown beside the choice. */
const TIER_PRICES = (["light", "standard", "deep"] as const).map((t) => ({ tier: t, words: TIERS[t].words, price: priceLine(TIERS[t]) }));

async function modelState(deps: RunDeps, now: string): Promise<{ available: boolean; enabled: boolean; name: string; words: string; meter: string; caps: Caps; tiers: typeof TIER_PRICES }> {
  const caps = deps.caps ?? DEFAULT_CAPS;
  if (!deps.model) return { available: false, enabled: false, name: "", words: "", meter: "", caps, tiers: TIER_PRICES };
  let enabled = true;
  let spend: SpendMonth = emptyMonth(monthOf(now));
  if (deps.store.ready) {
    const settings = await deps.store.getMeta<Settings>("settings").catch(() => null);
    enabled = settings?.model !== false;
    spend = (await deps.store.spend<SpendMonth>(monthOf(now)).catch(() => null)) ?? spend;
  }
  return { available: true, enabled, name: deps.model.name, words: deps.model.words, meter: describeMeter(spend, caps), caps, tiers: TIER_PRICES };
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
    let runs: RunRecord[] = [];
    let waiting: RunRecord[] = [];
    if (deps.store.ready) {
      try {
        [runs, waiting] = await Promise.all([deps.store.runs(10), deps.store.waiting()]);
      } catch (e) {
        deps.log?.(`could not list the records: ${plain(e)}`);
      }
    }
    return json(200, { ok: true, cloud: deps.store.state(), memory, memoryWired: deps.memory !== null, runs: runs.map(publicRun), waiting: waiting.map(publicRun), model: await modelState(deps, now()), tools: { groups: TOOL_GROUPS, notes: TOOL_NOTES }, timeZone: timeZone() });
  }
  // The templates are the catalogue's, not the store's: they show while the project is still being set up.
  if (method === "GET" && path === "/templates") {
    const zone = timeZone();
    return json(200, { ok: true, templates: TEMPLATES.map((t) => ({ ...t, files: t.files.map((f) => f.path), scheduleLine: t.schedule ? describeSchedule({ ...t.schedule, timeZone: zone }) : "" })) });
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

  if (method === "GET" && path === "/history") {
    const runs = await deps.store.runs(30);
    return json(200, { ok: true, runs: runs.map(publicRun) });
  }

  // ---- Ask your crew: the Planner routes a task on the fly (G3) ---------------------------------

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
  // ---- Templates: the live app's recipes, offered here (DESIGN §18, one product with the live app)
  const templateMatch = /^\/templates\/([a-z0-9-]+)\/activate$/.exec(path);
  if (method === "POST" && templateMatch) {
    const t = templateByKey(templateMatch[1]!);
    if (!t) return json(404, { ok: false, error: "not_found", message: "That template is not in the catalogue." });
    if (t.unavailable) return json(409, { ok: false, error: "not_yet", message: `${t.name} is coming to this edition — ${t.unavailable}, which it cannot do yet.` });
    const taken = new Set((await deps.store.agents()).map((a) => a.id));
    const { agent, files } = activateTemplate(t, taken, now(), timeZone());
    await deps.store.saveAgent(agent);
    for (const f of files) await deps.store.saveFile(f);
    return json(200, { ok: true, agent: { ...agent, scheduleLine: agent.schedule ? describeSchedule(agent.schedule) : "", nextRunAt: agent.schedule ? nextDue(agent.schedule, now()) : "" }, files: files.map((f) => f.path) });
  }
  // The alarms the host may set for this crew (DESIGN §18 G7): one per scheduled agent, as the cron
  // string a cloud scheduler takes, in the owner's zone. No schedule, no alarm — an idle crew is free.
  if (method === "GET" && path === "/cloud/slots") {
    const at = now();
    const slots = (await deps.store.agents())
      .filter((a): a is typeof a & { schedule: NonNullable<typeof a.schedule> } => !!a.schedule)
      .map((a) => ({ agent: a.id, name: a.name, cron: cronOf(a.schedule), timeZone: a.schedule.timeZone, line: describeSchedule(a.schedule), nextRunAt: nextDue(a.schedule, at), ...(a.schedule.task ? { task: a.schedule.task } : {}) }));
    return json(200, { ok: true, slots });
  }
  if (method === "GET" && path === "/agents") {
    const [agents, spend] = await Promise.all([deps.store.agents(), deps.store.spend<SpendMonth>(monthOf(now())).catch(() => null)]);
    const at = now();
    return json(200, { ok: true, agents: agents.map((a) => ({ ...a, ...usageOf(spend, a), scheduleLine: a.schedule ? describeSchedule(a.schedule) : "", nextRunAt: a.schedule ? nextDue(a.schedule, at) : "" })), });
  }
  if (method === "POST" && path === "/agents") {
    const input = (body ?? {}) as Record<string, unknown>;
    const problems = validateAgent(input, timeZone());
    if (problems.length > 0) return json(400, { ok: false, error: "bad_request", message: problems.join("; "), problems });
    const existing = typeof input.id === "string" ? await deps.store.agent(input.id) : null;
    const taken = new Set((await deps.store.agents()).map((a) => a.id));
    const agent = agentFrom(input, existing, now(), taken, timeZone());
    await deps.store.saveAgent(agent);
    const spendNow = await deps.store.spend<SpendMonth>(monthOf(now())).catch(() => null);
    return json(200, { ok: true, agent: { ...agent, ...usageOf(spendNow, agent), scheduleLine: agent.schedule ? describeSchedule(agent.schedule) : "", nextRunAt: agent.schedule ? nextDue(agent.schedule, now()) : "" } });
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
    const report = await applyPack(deps.store, read.pack, now(), new Set(), timeZone());
    return json(200, { ok: true, report, line: describePackReport(report) });
  }

  return json(404, { ok: false, error: "not_found", message: `no route for ${method} ${path}` });
}

/** A run as the page sees it — the paused conversation stays in the store. */
function publicRun(r: RunRecord): Omit<RunRecord, "conversation"> {
  const { conversation: _c, ...rest } = r;
  return rest;
}


function defaultId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function plain(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
