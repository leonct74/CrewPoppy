// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The Crew HQ on Google Cloud, first release (DESIGN.md §18): Today (the brief), Your crew, Past
 * briefs, Feedback. Talks to the host over the capability-gated bridge (inlined, as the AWS
 * edition's host.ts does) and to our own backend through the host. Every button reacts the
 * instant it is pressed; every error is one calm sentence.
 */
import { FORM, buildHelperPrompt } from "./helper-prompt";
import { defineFeedbackTab } from "./vendor/agentspoppy-feedback-tab";

interface BackendInvoke {
  method: string;
  path: string;
  body?: unknown;
}
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;
window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const res = e.data as { id?: unknown; ok?: boolean; result?: unknown; error?: string };
  if (!res || typeof res.id !== "string") return;
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  if (res.ok) p.resolve(res.result);
  else p.reject(new Error(res.error ?? "the host refused"));
});
function call<T>(method: string, ...params: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = `req-${Date.now().toString(36)}-${++seq}`;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ id, method, params }, "*");
    window.setTimeout(() => pending.delete(id) && reject(new Error(`AgentsPoppy did not answer "${method}" in time`)), 120_000);
  });
}
const host = {
  invokeBackend: <T>(req: BackendInvoke) => call<T>("invokeBackend", req),
  openExternal: (url: string) => call<void>("openExternal", url),
  notify: (n: { title: string; body: string }) => call<void>("notify", n),
};
defineFeedbackTab(host);

interface CloudState {
  state: string;
  projectId?: string;
  region?: string;
  created?: boolean;
  step?: string;
  message?: string;
}
interface MemoryInfo {
  available: boolean;
  provider?: { app: string; name: string };
  reads?: string[];
  error?: string;
}
interface BriefRecord {
  id: string;
  at: string;
  purpose: string;
  text: string;
  memoryIds: string[];
  receipts: string[];
  read: { events: number; people: number; bytes: number };
  writtenBy?: "model" | "template";
  model?: { name: string; words: string; promptTokens: number; outputTokens: number; ceilingUsd: number };
  note?: string;
}
interface ModelState {
  available: boolean;
  enabled: boolean;
  name: string;
  words: string;
  meter: string;
  caps: { callsPerDay: number; callsPerMonth: number; tokensPerMonth: number };
}
interface RunRecord {
  id: string;
  at: string;
  agent: string;
  request: string;
  tier: "none" | "light" | "standard" | "deep";
  why: string;
  choice: string;
  answer: string;
  read: { count: number; bytes: number; receipts: string[]; purpose: string };
  model?: { name: string; words: string; promptTokens: number; outputTokens: number; ceilingUsd: number };
  note?: string;
}
interface State {
  cloud: CloudState;
  memory: MemoryInfo | null;
  memoryWired: boolean;
  briefs: BriefRecord[];
  runs?: RunRecord[];
  purpose: string;
  model?: ModelState;
}
const TIER_WORDS: Record<RunRecord["tier"], string> = { none: "no model", light: "Gemini 2.5 Flash-Lite on Vertex AI", standard: "Gemini 2.5 Flash on Vertex AI", deep: "Gemini 2.5 Pro on Vertex AI" };
function planLine(r: RunRecord): string {
  const parts = [`Planner: ${r.why}`, TIER_WORDS[r.tier]];
  if (r.read.purpose) parts.push(`${r.read.count} ${r.read.count === 1 ? "memory" : "memories"} read`);
  if (r.model) {
    const usd = `$${Math.max(0.01, Math.round(r.model.ceilingUsd * 100) / 100).toFixed(2)}`;
    parts.push(`${(r.model.promptTokens + r.model.outputTokens).toLocaleString("en-GB")} tokens`, `at most ${usd}`);
  } else if (r.tier === "none") parts.push("no tokens");
  return `${parts.join(" · ")}.`;
}
function runReadLine(r: RunRecord): string {
  if (!r.read.purpose) return "Nothing read from your memory — the request was not about your life.";
  const kb = r.read.bytes >= 1024 ? `${(r.read.bytes / 1024).toFixed(1)} KB` : `${r.read.bytes} B`;
  return `Read ${r.read.count} ${r.read.count === 1 ? "memory" : "memories"} for ${r.read.purpose} — ${kb}. Written on your Activity${r.read.receipts.length ? ` (${r.read.receipts.length} ${r.read.receipts.length === 1 ? "receipt" : "receipts"})` : ""}.`;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
function setStatus(id: string, text: string, tone: "" | "warn" = ""): void {
  const el = $(id);
  el.className = `status${tone ? ` ${tone}` : ""}`;
  el.textContent = text;
}
/** The host wraps a backend refusal as `backend 502: {"ok":false,…}`; the user reads the sentence. */
function plainError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/^backend \d+: (\{.*\})$/s);
  if (m) {
    try {
      const body = JSON.parse(m[1]!) as { error?: string; message?: string };
      return body.message ?? body.error ?? raw;
    } catch {
      /* fall through */
    }
  }
  return raw.replace(/^backend \d+: /, "");
}
function withPending(btn: HTMLButtonElement, busyLabel: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

function describeCloud(cloud: CloudState | undefined): string {
  if (!cloud) return "";
  switch (cloud.state) {
    case "ready":
      return `Your crew's records live in your own project ${cloud.projectId}, database in ${cloud.region === "eur3" ? "Europe" : cloud.region === "nam5" ? "the United States" : cloud.region}${cloud.created ? " — created just now" : ""}.`;
    case "failed":
      return `Your crew's records are not reachable: ${cloud.message ?? "no reason given"}`;
    case "setting-up":
      return `Setting up your project — ${cloud.step ?? "one moment"}…`;
    default:
      return "Starting…";
  }
}
function describeMemory(m: MemoryInfo | null, wired: boolean): string {
  if (!wired) return "This build has no door to your memory.";
  if (!m) return "";
  if (m.error) return `Couldn't ask about your memory: ${m.error}`;
  if (!m.available) return "No memory poppy is installed yet — install MemoryPoppy, and the Briefer has something to read.";
  const words = (m.reads ?? []).map((k) => (k === "event" ? "meetings" : k === "person" ? "people" : k)).join(" and ");
  return `May read ${words || "nothing"} from ${m.provider?.name ?? "your memory poppy"}, for “Morning briefing” only.`;
}
/** "Written by Gemini 2.5 Flash on Vertex AI · 1,240 tokens · at most $0.01 at the ceiling." */
function writtenByLine(b: BriefRecord): string {
  if (b.writtenBy === "model" && b.model) {
    const tokens = b.model.promptTokens + b.model.outputTokens;
    const usd = b.model.ceilingUsd === 0 ? "$0.00" : `$${Math.max(0.01, Math.round(b.model.ceilingUsd * 100) / 100).toFixed(2)}`;
    return `Written by ${b.model.words} · ${tokens.toLocaleString("en-GB")} tokens · at most ${usd} at the ceiling.`;
  }
  return b.note ?? "Written by the Briefer itself, without a model.";
}
function readLine(b: BriefRecord): string {
  const parts: string[] = [];
  if (b.read.events) parts.push(`${b.read.events} ${b.read.events === 1 ? "meeting" : "meetings"}`);
  if (b.read.people) parts.push(`${b.read.people} ${b.read.people === 1 ? "person" : "people"}`);
  const kb = b.read.bytes >= 1024 ? `${(b.read.bytes / 1024).toFixed(1)} KB` : `${b.read.bytes} B`;
  return `Read ${parts.length ? parts.join(" and ") : "nothing"} for “${b.purpose}” — ${kb}. Written on your Activity${b.receipts.length ? ` (${b.receipts.length} ${b.receipts.length === 1 ? "receipt" : "receipts"})` : ""}.`;
}

// ---- tabs
const TABS = ["today", "crew", "briefs", "feedback"] as const;
for (const tab of document.querySelectorAll<HTMLElement>("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll<HTMLElement>("[role=tab]")) t.setAttribute("aria-selected", String(t === tab));
    for (const s of TABS) $(`tab-${s}`).hidden = s !== tab.dataset.tab;
    if (tab.dataset.tab === "crew") void renderAgents();
  });
}

// ---- today
let settleTimer: number | undefined;
function showBrief(b: BriefRecord | undefined): void {
  if (!b) {
    $("brief-when").textContent = "";
    $("brief").className = "brief muted";
    $("brief").textContent = "No brief yet. Press “Brief me now” and the Briefer reads the week ahead and the month behind from your memory.";
    $("receipt").textContent = "";
    setStatus("written-by", "");
    return;
  }
  $("brief-when").textContent = `Written ${when(b.at)}`;
  $("brief").className = "brief";
  $("brief").textContent = b.text;
  $("receipt").textContent = readLine(b);
  setStatus("written-by", writtenByLine(b));
}
function renderModel(m: ModelState | undefined): void {
  const sw = $<HTMLInputElement>("model-switch");
  if (!m || !m.available) {
    $("model-panel").hidden = true;
    return;
  }
  $("model-panel").hidden = false;
  sw.checked = m.enabled;
  $("model-label").textContent = `The Briefer writes with ${m.words}, inside this project — billed to your Google Cloud, capped by CrewPoppy.`;
  $("meter").textContent = m.meter;
}
async function refresh(): Promise<void> {
  try {
    const state = await host.invokeBackend<State>({ method: "GET", path: "/state" });
    setStatus("where", describeCloud(state.cloud), state.cloud?.state === "failed" ? "warn" : "");
    $("memory-line").textContent = describeMemory(state.memory, state.memoryWired);
    if (state.cloud && (state.cloud.state === "setting-up" || state.cloud.state === "starting")) {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => void refresh(), 3000);
      $("brief").className = "brief muted";
      $("brief").textContent = "Your crew's project is being set up. This takes about a minute the first time.";
      return;
    }
    showBrief(state.briefs[0]);
    renderHistory(state.briefs, state.runs ?? []);
    renderModel(state.model);
  } catch (err) {
    setStatus("where", `Couldn't reach the Briefer: ${plainError(err)}`, "warn");
  }
}
$<HTMLButtonElement>("btn-brief").addEventListener(
  "click",
  withPending($("btn-brief"), "Reading your memory…", async () => {
    setStatus("brief-status", "");
    try {
      const r = await host.invokeBackend<{ brief: BriefRecord; truncated: boolean }>({ method: "POST", path: "/brief" });
      showBrief(r.brief);
      if (r.truncated) setStatus("brief-status", "Your memory held more than the Briefer asked for — it read the first forty meetings.");
      await refresh();
    } catch (err) {
      setStatus("brief-status", `The Briefer couldn't write today's brief: ${plainError(err)}`, "warn");
    }
  }),
);

// ---- ask your crew
function showAnswer(r: RunRecord): void {
  $("answer-wrap").hidden = false;
  $("answer").textContent = r.answer;
  $("plan-line").textContent = planLine(r);
  $("answer-read").textContent = runReadLine(r);
  setStatus("ask-status", r.note ?? "");
}
$<HTMLButtonElement>("btn-ask").addEventListener(
  "click",
  withPending($("btn-ask"), "Asking…", async () => {
    const request = ($("ask") as HTMLTextAreaElement).value.trim();
    const choice = ($("ask-choice") as HTMLSelectElement).value;
    if (!request) {
      setStatus("ask-status", "Ask something — a request in your own words.");
      return;
    }
    setStatus("ask-status", "The Planner is reading and judging…");
    try {
      const r = await host.invokeBackend<{ run: RunRecord }>({ method: "POST", path: "/ask", body: { request, choice } });
      showAnswer(r.run);
      await refresh();
    } catch (err) {
      setStatus("ask-status", `Your crew couldn't answer: ${plainError(err)}`, "warn");
    }
  }),
);
$("ask").addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("btn-ask").click();
});

// ---- your own agents (G3b)
interface AgentDef {
  id: string;
  name: string;
  role: string;
  instructions: string;
  tier: "auto" | "light" | "standard" | "deep";
  memory: boolean;
  capUsd: number;
  monthUsd?: number;
}
const money = (n: number): string => (n === 0 ? "$0.00" : `$${Math.max(0.01, Math.round(n * 100) / 100).toFixed(2)}`);
const TIER_LABEL: Record<AgentDef["tier"], string> = Object.fromEntries(FORM.tiers.map((t) => [t.value, t.label])) as Record<AgentDef["tier"], string>;

function fillTierSelect(): void {
  const sel = $<HTMLSelectElement>("agent-tier");
  sel.innerHTML = FORM.tiers.map((t) => `<option value="${t.value}">${esc(t.label)}</option>`).join("");
  const note = (): void => {
    $("agent-tier-note").textContent = FORM.tiers.find((t) => t.value === sel.value)?.note ?? "";
  };
  sel.addEventListener("change", note);
  note();
}
fillTierSelect();

function resetAgentForm(): void {
  ($("agent-id") as HTMLInputElement).value = "";
  ($("agent-name") as HTMLInputElement).value = "";
  ($("agent-role") as HTMLInputElement).value = "";
  ($("agent-instructions") as HTMLTextAreaElement).value = "";
  ($("agent-tier") as HTMLSelectElement).value = "auto";
  ($("agent-tier") as HTMLSelectElement).dispatchEvent(new Event("change"));
  ($("agent-memory") as HTMLInputElement).checked = true;
  ($("agent-cap") as HTMLInputElement).value = String(FORM.cap.default);
  $("new-agent-title").textContent = "New agent";
  $("btn-save-agent").textContent = "Add to the crew";
  $("btn-cancel-agent").hidden = true;
}
function editAgent(a: AgentDef): void {
  ($("agent-id") as HTMLInputElement).value = a.id;
  ($("agent-name") as HTMLInputElement).value = a.name;
  ($("agent-role") as HTMLInputElement).value = a.role;
  ($("agent-instructions") as HTMLTextAreaElement).value = a.instructions;
  ($("agent-tier") as HTMLSelectElement).value = a.tier;
  ($("agent-tier") as HTMLSelectElement).dispatchEvent(new Event("change"));
  ($("agent-memory") as HTMLInputElement).checked = a.memory;
  ($("agent-cap") as HTMLInputElement).value = String(a.capUsd);
  $("new-agent-title").textContent = `Edit ${a.name}`;
  $("btn-save-agent").textContent = "Save";
  $("btn-cancel-agent").hidden = false;
  $("new-agent-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("btn-cancel-agent").addEventListener("click", resetAgentForm);

$<HTMLFormElement>("agent-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void withPending($("btn-save-agent"), "Saving…", async () => {
    const id = ($("agent-id") as HTMLInputElement).value;
    const body = {
      ...(id ? { id } : {}),
      name: ($("agent-name") as HTMLInputElement).value,
      role: ($("agent-role") as HTMLInputElement).value,
      instructions: ($("agent-instructions") as HTMLTextAreaElement).value,
      tier: ($("agent-tier") as HTMLSelectElement).value,
      memory: ($("agent-memory") as HTMLInputElement).checked,
      capUsd: Number(($("agent-cap") as HTMLInputElement).value),
    };
    try {
      const r = await host.invokeBackend<{ agent: AgentDef }>({ method: "POST", path: "/agents", body });
      setStatus("agent-status", `${r.agent.name} is ${id ? "saved" : "in the crew"}.`);
      resetAgentForm();
      await renderAgents();
    } catch (err) {
      setStatus("agent-status", plainError(err), "warn");
    }
  })();
});

// The helper prompt: built live from the form's catalogue; copied, or shown when the frame may not copy.
$<HTMLButtonElement>("btn-helper").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("btn-helper");
  const text = buildHelperPrompt();
  btn.classList.remove("poppy-helper-pulse");
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied ✓";
  } catch {
    const box = $<HTMLTextAreaElement>("helper-text");
    box.value = text;
    box.hidden = false;
    box.select();
    btn.textContent = "Select and copy the text below";
  }
  window.setTimeout(() => {
    btn.textContent = "Copy the helper prompt";
  }, 2500);
});

async function renderAgents(): Promise<void> {
  const el = $("agents");
  let agents: AgentDef[] = [];
  try {
    agents = (await host.invokeBackend<{ agents: AgentDef[] }>({ method: "GET", path: "/agents" })).agents;
  } catch (err) {
    el.innerHTML = `<div class="status warn">${esc(`Couldn't read your agents: ${plainError(err)}`)}</div>`;
    return;
  }
  el.innerHTML = agents
    .map(
      (a) => `<div class="agent" data-id="${esc(a.id)}">
        <div class="row" style="justify-content:space-between">
          <div><strong>${esc(a.name)}</strong> <span class="muted">· ${esc(a.role)}</span></div>
          <span class="muted small">${esc(TIER_LABEL[a.tier] ?? a.tier)} · ${a.memory ? "reads your memory" : "no memory"} · this month ${esc(money(a.monthUsd ?? 0))} / ${esc(money(a.capUsd))}</span>
        </div>
        <div class="muted small">${esc(a.instructions.length > 220 ? `${a.instructions.slice(0, 220)}…` : a.instructions)}</div>
        <div class="run">
          <textarea class="agent-request" rows="2" placeholder="Anything for this run? Leave empty and ${esc(a.name)} does the job as briefed." aria-label="Request for ${esc(a.name)}"></textarea>
          <div class="row" style="margin-top:6px">
            <button class="btn" data-run="${esc(a.id)}">Run ${esc(a.name)}</button>
            <button class="ghost" data-edit="${esc(a.id)}">Edit</button>
            <button class="ghost danger-text" data-remove="${esc(a.id)}">Remove</button>
          </div>
          <div class="confirm" data-confirm="${esc(a.id)}" hidden>
            <p style="margin:0 0 8px">Remove ${esc(a.name)} from the crew? Its brief goes; its past runs stay in History. This can't be undone.</p>
            <div class="row"><button class="ghost" data-keep="${esc(a.id)}">Keep</button><button class="btn danger" data-remove-yes="${esc(a.id)}">Remove ${esc(a.name)}</button></div>
          </div>
          <div class="answer" data-answer="${esc(a.id)}"></div>
          <div class="receipt" data-plan="${esc(a.id)}"></div>
          <div class="status" data-status="${esc(a.id)}"></div>
        </div>
      </div>`,
    )
    .join("");
  const q = (sel: string): HTMLElement => el.querySelector<HTMLElement>(sel)!;
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-run]")) {
    const id = btn.dataset.run ?? "";
    btn.addEventListener(
      "click",
      withPending(btn, "Running…", async () => {
        const request = (q(`.agent[data-id="${id}"] .agent-request`) as HTMLTextAreaElement).value.trim();
        q(`[data-status="${id}"]`).textContent = "The Planner is reading and judging…";
        try {
          const r = await host.invokeBackend<{ ok: boolean; run?: RunRecord; planLine?: string; message?: string; agent?: AgentDef }>({ method: "POST", path: `/agents/${encodeURIComponent(id)}/run`, body: { request } });
          if (!r.ok || !r.run) {
            q(`[data-status="${id}"]`).textContent = r.message ?? "It did not run.";
            return;
          }
          q(`[data-answer="${id}"]`).textContent = r.run.answer;
          q(`[data-plan="${id}"]`).textContent = `${planLine(r.run)} ${runReadLine(r.run)}`;
          q(`[data-status="${id}"]`).textContent = r.run.note ?? "";
          await refresh();
          await renderAgents();
          q(`[data-answer="${id}"]`).textContent = r.run.answer;
          q(`[data-plan="${id}"]`).textContent = `${planLine(r.run)} ${runReadLine(r.run)}`;
        } catch (err) {
          q(`[data-status="${id}"]`).textContent = plainError(err);
        }
      }),
    );
  }
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-edit]")) {
    btn.addEventListener("click", () => {
      const a = agents.find((x) => x.id === btn.dataset.edit);
      if (a) editAgent(a);
    });
  }
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-remove]")) {
    btn.addEventListener("click", () => {
      q(`[data-confirm="${btn.dataset.remove}"]`).hidden = false;
      q(`button[data-keep="${btn.dataset.remove}"]`).focus();
    });
  }
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-keep]")) {
    btn.addEventListener("click", () => {
      q(`[data-confirm="${btn.dataset.keep}"]`).hidden = true;
    });
  }
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-remove-yes]")) {
    const id = btn.dataset.removeYes ?? "";
    btn.addEventListener(
      "click",
      withPending(btn, "Removing…", async () => {
        try {
          await host.invokeBackend({ method: "POST", path: `/agents/${encodeURIComponent(id)}/delete` });
          await renderAgents();
        } catch (err) {
          q(`[data-status="${id}"]`).textContent = plainError(err);
        }
      }),
    );
  }
}

// ---- the model switch: reacts at once, and says what happened
$<HTMLInputElement>("model-switch").addEventListener("change", async (e) => {
  const sw = e.target as HTMLInputElement;
  const wanted = sw.checked;
  sw.disabled = true;
  setStatus("model-status", wanted ? "Switching the model on…" : "Switching the model off…");
  try {
    const r = await host.invokeBackend<{ model: ModelState }>({ method: "POST", path: "/settings", body: { model: wanted } });
    renderModel(r.model);
    setStatus("model-status", wanted ? "On. The next brief is written by the model." : "Off. The Briefer writes the next brief itself, and nothing is billed.");
  } catch (err) {
    sw.checked = !wanted;
    setStatus("model-status", `Couldn't change that: ${plainError(err)}`, "warn");
  } finally {
    sw.disabled = false;
  }
});

// ---- history
function renderHistory(briefs: BriefRecord[], runs: RunRecord[] = []): void {
  const el = $("history");
  const items = [
    ...briefs.map((b) => ({
      at: b.at,
      html: `<div class="brief-when">${esc(when(b.at))} · brief</div>
        <div class="brief" style="font-size:13px">${esc(b.text)}</div>
        <details><summary>What was read, and who wrote it</summary><div class="receipt">${esc(readLine(b))}</div><div class="receipt">${esc(writtenByLine(b))}</div>
          <ul class="plain">${b.memoryIds.map((id) => `<li class="mono">${esc(id)}</li>`).join("")}</ul></details>`,
    })),
    ...runs.map((r) => ({
      at: r.at,
      html: `<div class="brief-when">${esc(when(r.at))} · asked</div>
        <div class="muted small">${esc(r.request.length > 200 ? `${r.request.slice(0, 200)}…` : r.request)}</div>
        <div class="brief" style="font-size:13px">${esc(r.answer)}</div>
        <div class="receipt">${esc(planLine(r))}</div>
        <div class="receipt">${esc(runReadLine(r))}</div>${r.note ? `<div class="status">${esc(r.note)}</div>` : ""}`,
    })),
  ].sort((x, y) => (x.at < y.at ? 1 : -1));
  if (items.length === 0) {
    el.className = "history muted";
    el.textContent = "Nothing yet — ask your crew something, or press “Brief me now”.";
    return;
  }
  el.className = "history";
  el.innerHTML = items.map((i) => `<div class="item">${i.html}</div>`).join("");
}

void refresh();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
