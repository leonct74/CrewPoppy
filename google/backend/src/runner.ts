// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The runner (DESIGN.md §5; §18 G3): one run of a crew member, from the Planner's judgement to
 * the record in `runs`. It owns the caps, the up-front memory read, the run's record and the
 * resume after an ask; the LOOP owns the conversation and the DISPATCHER owns every tool. The
 * Assistant answers on the fly through the same loop, with the memory search as its one tool.
 */
import type { Memory } from "@agentspoppy/core";
import { memoryBytes } from "@agentspoppy/core";
import { type AgentDef, instructionsFor, toolsFor } from "./agents";
import { type DispatchContext, dispatch } from "./dispatcher";
import { judgeTier, judgeWords } from "./judge";
import { type LoopOutcome, type Usage, MAX_ITERATIONS, MAX_RUN_MS, answered, runLoop } from "./loop";
import { memoriesAsMaterial } from "./material";
import type { MemoryReader, ReceiptHints } from "./memory-reader";
import { type Plan, TIERS, type TierSpec, classify, priceLine } from "./planner";
import { type Caps, DEFAULT_CAPS, type SpendMonth, agentSpent, ceilingUsd, emptyMonth, listUsd, mayCall, monthOf, recordCall, usd, usdFine } from "./spend";
import type { CrewStore, RunRecord, Settings } from "./store";
import { MEMORY_TOOL, specsFor } from "./tools";
import type { FunctionDeclaration, Model } from "./vertex";

export interface RunDeps {
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
  /** Where this process runs: the app (default) or the cloud job — stamped on every run it makes. */
  via?: "app" | "cloud";
}

export type RunReply = { ok: true; run: RunRecord; planLine: string; agent?: AgentDef & { monthUsd: number } } | { ok: false; error: string; message: string };

const ASK_MEMORY_LIMIT = 20;
const ASK_MEMORY_BUDGET = 6_000;
/** A paused conversation bigger than this is not kept — the run stops and says so. */
const MAX_CONVERSATION_CHARS = 800_000;

function settle(deps: RunDeps) {
  return {
    now: deps.now ?? (() => new Date().toISOString()),
    timeZone: deps.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"),
    newId: deps.newId ?? defaultId,
    caps: deps.caps ?? DEFAULT_CAPS,
  };
}

async function modelOn(deps: RunDeps): Promise<boolean> {
  if (!deps.model) return false;
  const settings = (await deps.store.getMeta<Settings>("settings").catch(() => null)) ?? {};
  return settings.model !== false;
}

/** The month's counters, live: read before the run and after every call, written after every call. */
class Meter {
  spend: SpendMonth;
  /** The run so far: at the ceiling (the cap's figure) and at Google's price (the shown figure). */
  runUsd = 0;
  runListUsd = 0;
  constructor(
    private readonly deps: RunDeps,
    private readonly month: string,
    spend: SpendMonth,
    /** The tier's ceiling rate and Google's price — set again once the judge has spoken. */
    public rate: number,
    public rates: { in: number; out: number },
    private readonly agentId?: string,
  ) {
    this.spend = spend;
  }
  static async open(deps: RunDeps, at: string, tier: TierSpec, agentId?: string): Promise<Meter> {
    const month = monthOf(at);
    const spend = (await deps.store.spend<SpendMonth>(month).catch(() => null)) ?? emptyMonth(month);
    return new Meter(deps, month, spend, tier.ceilingUsdPerMillion, tier.listUsdPerMillion, agentId);
  }
  async record(promptTokens: number, outputTokens: number, at: string, rate = this.rate, rates = this.rates): Promise<number> {
    const callUsd = ceilingUsd(promptTokens + outputTokens, rate);
    const callListUsd = listUsd(promptTokens, outputTokens, rates);
    this.runUsd += callUsd;
    this.runListUsd += callListUsd;
    this.spend = recordCall(this.spend, promptTokens, outputTokens, at, callUsd, this.agentId, callListUsd);
    await this.deps.store.saveSpend(this.month, this.spend);
    return callUsd;
  }
}

/** One read of the memory before the model speaks — the Planner's, in the user's words. */
async function readMemory(deps: RunDeps, purpose: string, query: string, hints: ReceiptHints): Promise<{ memories: Memory[]; receipts: string[]; note?: string }> {
  if (!deps.memory) return { memories: [], receipts: [] };
  try {
    const page = await deps.memory.search({ purpose, query: query || undefined, limit: ASK_MEMORY_LIMIT, budget: ASK_MEMORY_BUDGET, ...hints });
    return { memories: page.memories, receipts: page.receipt ? [page.receipt] : [] };
  } catch (e) {
    return { memories: [], receipts: [], note: `Your memory could not be read: ${plain(e)}` };
  }
}

function hintsFor(tier: TierSpec, extraTokens: number): ReceiptHints {
  // No guessed amount on the receipt (founder, 2026-09-08): the model's name is the fact; the tokens are known only after the run.
  void extraTokens;
  return { model: tier.words };
}

interface Drive {
  system: string;
  task?: string;
  priorContents?: unknown[];
  tools: FunctionDeclaration[];
  tier: TierSpec;
  ctx: DispatchContext;
  meter: Meter;
  capUsd?: number;
  agentName: string;
}

/** The loop, wired: the model of the tier, the dispatcher for this agent, the caps asked before every call. */
async function drive(deps: RunDeps, d: Drive): Promise<LoopOutcome> {
  const { now, caps } = settle(deps);
  const model = deps.model!;
  return runLoop(
    { task: d.task, priorContents: d.priorContents, tools: d.tools, maxOutputTokens: d.tier.maxOutputTokens },
    {
      callModel: (req) => model.converse({ system: d.system, contents: req.contents, tools: req.tools, maxOutputTokens: req.maxOutputTokens, model: d.tier.model }),
      dispatch: (name, args) => dispatch(d.ctx, name, args),
      async mayContinue(_usage: Usage, iterations: number, elapsedMs: number) {
        if (iterations >= MAX_ITERATIONS) return { ok: false, reason: `the run reached its limit of ${MAX_ITERATIONS} turns` };
        if (elapsedMs > MAX_RUN_MS) return { ok: false, reason: "the run took longer than four minutes" };
        const allowed = mayCall(d.meter.spend, caps, now());
        if (!allowed.ok) return allowed;
        if (d.capUsd !== undefined && d.ctx.agentId && agentSpent(d.meter.spend, d.ctx.agentId) >= d.capUsd) return { ok: false, reason: `${d.agentName}'s monthly limit of ${usd(d.capUsd)} (at the ceiling) is reached` };
        return { ok: true };
      },
      recordCall: async (p, o) => {
        await d.meter.record(p, o, now());
      },
      now,
    },
  );
}

/** The run's record after the loop: the answer, the steps, the reads, the cost, the pause. */
function settled(run: RunRecord, outcome: LoopOutcome, tier: TierSpec, meter: Meter, agentName: string, now: string): RunRecord {
  const promptTokens = (run.model?.promptTokens ?? 0) + outcome.usage.promptTokens;
  const outputTokens = (run.model?.outputTokens ?? 0) + outcome.usage.outputTokens;
  const receipts = [...run.read.receipts, ...outcome.reads.flatMap((r) => (r.receipt ? [r.receipt] : []))];
  const read = { ...run.read, count: run.read.count + outcome.reads.reduce((n, r) => n + r.count, 0), bytes: run.read.bytes + outcome.reads.reduce((n, r) => n + r.bytes, 0), receipts };
  let status = outcome.status;
  let note = run.note;
  let conversation: string | undefined;
  if (status === "stopped" && outcome.reason) note = `${agentName} stopped: ${outcome.reason}`;
  if (status === "waiting") {
    conversation = JSON.stringify(outcome.contents);
    if (conversation.length > MAX_CONVERSATION_CHARS) {
      status = "stopped";
      note = `${agentName} stopped: the conversation grew too large to pause for your answer`;
      conversation = undefined;
    }
  }
  const { question: _q, conversation: _c, ...rest } = run;
  return {
    ...rest,
    status,
    answer: outcome.output,
    read,
    steps: [...(run.steps ?? []), ...outcome.steps],
    iterations: (run.iterations ?? 0) + outcome.iterations,
    toolsUsed: [...new Set([...(run.toolsUsed ?? []), ...outcome.toolsUsed])],
    ...(promptTokens + outputTokens > 0 ? { model: { name: tier.model, words: tier.words, promptTokens, outputTokens, ceilingUsd: (run.model?.ceilingUsd ?? 0) + meter.runUsd, listUsd: (run.model?.listUsd ?? 0) + meter.runListUsd, price: priceLine(tier) } } : {}),
    ...(note ? { note } : {}),
    ...(status === "waiting" && outcome.question ? { question: outcome.question, conversation } : {}),
    ...(run.answeredAt ? { answeredAt: run.answeredAt } : {}),
    ...(status !== "waiting" && run.question ? { answeredAt: now } : {}),
  };
}

export interface RunOptions {
  trigger: "run" | "schedule";
  slot?: string;
  late?: string;
  /** A schedule's run id is derived from its slot, so a slot runs once. */
  id?: string;
}

/**
 * One run of an agent the user defined: the Planner picks the tier (the agent's own, or by the
 * request — or the judge's word when the rules cannot place it), reads the memory when the agent
 * may, then the model speaks as the agent with its tools — under the crew's caps and the agent's
 * own monthly cap. Kept in `runs` like an ask.
 */
export async function runAgent(deps: RunDeps, agent: AgentDef, request: string, opts: RunOptions): Promise<RunReply> {
  const { now, timeZone, newId, caps } = settle(deps);
  const at = now();
  const task = request || agent.instructions;
  if (!(await modelOn(deps))) return { ok: false, error: "model_off", message: deps.model ? "The model is switched off — turn it on under Your crew to run an agent." : "This build has no model." };
  let plan: Plan = agent.tier === "auto" ? classify(task) : { tier: agent.tier, why: `${agent.name}'s own setting`, wantsMemory: true, memoryQuery: "", placed: true };
  if (plan.tier === "none") plan = { ...plan, tier: "light", why: "a light task, by the request" }; // an agent always answers in its own words
  const meter = await Meter.open(deps, at, TIERS[plan.tier], agent.id);
  const allowed = mayCall(meter.spend, caps, at);
  if (!allowed.ok) return { ok: false, error: "capped", message: `${agent.name} did not run: ${allowed.reason}.` };
  if (agentSpent(meter.spend, agent.id) >= agent.capUsd) return { ok: false, error: "capped", message: `${agent.name} did not run: its monthly limit of ${usd(agent.capUsd)} (at the ceiling) is reached — raise it on the agent, or wait for next month.` };
  // The judge: the smallest model's one word, only when no rule placed the request.
  let judge: RunRecord["judge"] | undefined;
  if (agent.tier === "auto" && plan.placed === false) {
    const j = await judgeTier(deps.model!, task);
    if (j) {
      const judgeUsd = await meter.record(j.promptTokens, j.outputTokens, at, TIERS.light.ceilingUsdPerMillion, TIERS.light.listUsdPerMillion);
      judge = { tier: j.tier, promptTokens: j.promptTokens, outputTokens: j.outputTokens, ceilingUsd: judgeUsd, listUsd: listUsd(j.promptTokens, j.outputTokens, TIERS.light.listUsdPerMillion) };
      plan = { ...plan, tier: j.tier, why: judgeWords(j.tier), placed: true };
    }
  }
  const tier = TIERS[plan.tier];
  meter.rate = tier.ceilingUsdPerMillion;
  meter.rates = tier.listUsdPerMillion;
  const purpose = `${agent.name}: "${task.length > 120 ? `${task.slice(0, 119)}…` : task}"`;
  const hints = hintsFor(tier, 400);
  const consult = agent.memory && !!deps.memory;
  const first = consult ? await readMemory(deps, purpose, agent.tier === "auto" ? plan.memoryQuery : "", hints) : { memories: [], receipts: [] as string[] };
  const run: RunRecord = {
    id: opts.id ?? newId(),
    at,
    agent: agent.id,
    agentName: agent.name,
    via: deps.via ?? "app",
    request: request || `(${agent.name}'s brief)`,
    tier: plan.tier,
    why: plan.why,
    choice: "auto",
    answer: "",
    read: { count: first.memories.length, bytes: first.memories.reduce((n, m) => n + memoryBytes(m), 0), receipts: first.receipts, purpose: consult ? purpose : "" },
    status: "running",
    trigger: opts.trigger,
    ...(opts.slot ? { slot: opts.slot } : {}),
    ...(opts.late ? { late: opts.late } : {}),
    ...(judge ? { judge } : {}),
    ...(first.note ? { note: first.note } : {}),
  };
  // The judge's tokens are on the record from the start; its dollars are already on the meter, which the settled run adds once.
  if (judge) run.model = { name: tier.model, words: tier.words, promptTokens: judge.promptTokens, outputTokens: judge.outputTokens, ceilingUsd: 0, listUsd: 0, price: priceLine(tier) };
  await deps.store.saveRun(run).catch((e) => deps.log?.(`could not save the run: ${plain(e)}`));
  const enabled = toolsFor(agent);
  const ctx: DispatchContext = { agentId: agent.id, agentName: agent.name, enabled, purpose, hints, memory: deps.memory, store: deps.store, timeZone: timeZone(), now, log: deps.log };
  const user = `${request ? `REQUEST:\n${request}\n\n` : "Do your job as briefed.\n\n"}${memoriesAsMaterial(first.memories, timeZone(), consult)}\n\nAnswer in at most ${tier.maxWords} words.`;
  let outcome: LoopOutcome;
  let ran = tier;
  let escalated: string | undefined;
  try {
    try {
      outcome = await drive(deps, { system: instructionsFor(agent), task: user, tools: specsFor(enabled), tier, ctx, meter, capUsd: agent.capUsd, agentName: agent.name });
    } catch (e) {
      // 🪤 LIVE (2026-09-08, the first cloud run): Flash-Lite garbled its tool calls twice even with
      // thinking on. An agent with tools then gets the standard model for this run, and the run says so.
      if (!(tier.tier === "light" && enabled.length > 0 && /garbled a tool call/i.test(plain(e)))) throw e;
      ran = TIERS.standard;
      meter.rate = ran.ceilingUsdPerMillion;
  meter.rates = ran.listUsdPerMillion;
      escalated = `the small model garbled its tool calls, so ${ran.words} did this run`;
      outcome = await drive(deps, { system: instructionsFor(agent), task: user, tools: specsFor(enabled), tier: ran, ctx, meter, capUsd: agent.capUsd, agentName: agent.name });
    }
  } catch (e) {
    const failed: RunRecord = { ...run, tier: ran.tier, status: "stopped", note: `${agent.name} could not answer — ${plain(e)}`, ...(meter.runUsd > 0 ? { model: { name: ran.model, words: ran.words, promptTokens: run.model?.promptTokens ?? 0, outputTokens: run.model?.outputTokens ?? 0, ceilingUsd: meter.runUsd } } : {}) };
    await deps.store.saveRun(failed).catch(() => {});
    return { ok: false, error: "model_failed", message: `${agent.name} could not answer — ${plain(e)}` };
  }
  const done = settled({ ...run, tier: ran.tier, why: escalated ? `${run.why}; ${escalated}` : run.why }, outcome, ran, meter, agent.name, now());
  await deps.store.saveRun(done).catch((e) => deps.log?.(`could not save the run: ${plain(e)}`));
  return { ok: true, run: done, planLine: describePlan(done), agent: { ...agent, monthUsd: agentSpent(meter.spend, agent.id) } };
}

/** The user answered: the conversation resumes where the agent asked, with the same tools and caps. */
export async function resumeRun(deps: RunDeps, run: RunRecord, answer: string): Promise<RunReply> {
  const { now, timeZone } = settle(deps);
  if (run.status !== "waiting" || !run.conversation) return { ok: false, error: "not_waiting", message: "That run is not waiting for an answer." };
  if (!(await modelOn(deps))) return { ok: false, error: "model_off", message: "The model is switched off — turn it on under Your crew to continue." };
  const agent = await deps.store.agent(run.agent);
  if (!agent) return { ok: false, error: "not_found", message: "That agent is no longer in your crew." };
  const tier = TIERS[run.tier === "none" ? "light" : run.tier];
  const at = now();
  const meter = await Meter.open(deps, at, tier, agent.id);
  const allowed = mayCall(meter.spend, DEFAULT_CAPS, at);
  if (!allowed.ok) return { ok: false, error: "capped", message: `The run cannot continue: ${allowed.reason}.` };
  const name = agent.name;
  const enabled = toolsFor(agent);
  const ctx: DispatchContext = { agentId: agent.id, agentName: name, enabled, purpose: run.read.purpose || `${name}: "${run.request.slice(0, 119)}"`, hints: hintsFor(tier, 400), memory: deps.memory, store: deps.store, timeZone: timeZone(), now, log: deps.log };
  const resumed: RunRecord = { ...run, status: "running", steps: [...(run.steps ?? []), { at, kind: "result", text: `You answered: ${answer}` }], answeredAt: at };
  await deps.store.saveRun(resumed).catch(() => {});
  let outcome: LoopOutcome;
  try {
    outcome = await drive(deps, { system: instructionsFor(agent), priorContents: answered(JSON.parse(run.conversation) as unknown[], answer), tools: specsFor(enabled), tier, ctx, meter, capUsd: agent.capUsd, agentName: name });
  } catch (e) {
    const failed: RunRecord = { ...resumed, status: "stopped", note: `${name} could not continue — ${plain(e)}` };
    delete failed.conversation;
    delete failed.question;
    await deps.store.saveRun(failed).catch(() => {});
    return { ok: false, error: "model_failed", message: `${name} could not continue — ${plain(e)}` };
  }
  const done = settled(resumed, outcome, tier, meter, name, now());
  await deps.store.saveRun(done).catch((e) => deps.log?.(`could not save the run: ${plain(e)}`));
  return { ok: true, run: done, planLine: describePlan(done), agent: { ...agent, monthUsd: agentSpent(meter.spend, agent.id) } };
}

/** "Gemini 2.5 Flash-Lite on Vertex AI — Emma's own setting · 1 memory read · 1,202 tokens (963 in, 239 out) ≈ $0.0002 at Google's price." */
export function describePlan(r: RunRecord): string {
  const parts = [`${r.tier === "none" ? "no model" : TIERS[r.tier].words} — ${r.why}`];
  if (r.read.purpose) parts.push(`${r.read.count} ${r.read.count === 1 ? "memory" : "memories"} read`);
  if (r.model) parts.push(`${(r.model.promptTokens + r.model.outputTokens).toLocaleString("en-GB")} tokens (${r.model.promptTokens.toLocaleString("en-GB")} in, ${r.model.outputTokens.toLocaleString("en-GB")} out)${r.model.listUsd !== undefined ? ` ≈ ${usdFine(r.model.listUsd)} at Google's price` : ""}`);
  else if (r.tier === "none") parts.push("no tokens");
  return `${parts.join(" · ")}.`;
}

function defaultId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function plain(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
