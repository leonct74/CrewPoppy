// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The Crew HQ on Google Cloud (DESIGN.md §18): Today (ask your crew, the runs waiting for you, the
 * brief), Your crew (the built-in members, your own agents with their tools and schedules, the
 * Crew Pack), History, Feedback. Talks to the host over the capability-gated bridge (inlined, as
 * the AWS edition's host.ts does) and to our own backend through the host. Every button reacts
 * the instant it is pressed; every error is one calm sentence.
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
    window.setTimeout(() => pending.delete(id) && reject(new Error(`AgentsPoppy did not answer "${method}" in time`)), 300_000);
  });
}
const host = {
  invokeBackend: <T>(req: BackendInvoke) => call<T>("invokeBackend", req),
  openExternal: (url: string) => call<void>("openExternal", url),
  notify: (n: { title: string; body: string }) => call<void>("notify", n),
  getConnection: () => call<{ app: { id: string } }>("getConnection"),
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
interface ModelState {
  available: boolean;
  enabled: boolean;
  name: string;
  words: string;
  meter: string;
  tiers?: Array<{ tier: string; words: string; price: string }>;
  caps: { callsPerDay: number; callsPerMonth: number; tokensPerMonth: number };
}
interface Step {
  at: string;
  kind: "model" | "tool" | "result" | "asked" | "stopped";
  text: string;
}
interface RunRecord {
  id: string;
  at: string;
  agent: string;
  agentName?: string;
  request: string;
  tier: "none" | "light" | "standard" | "deep";
  why: string;
  choice: string;
  answer: string;
  read: { count: number; bytes: number; receipts: string[]; purpose: string };
  model?: { name: string; words: string; promptTokens: number; outputTokens: number; ceilingUsd: number; listUsd?: number; price?: string };
  note?: string;
  status?: "running" | "succeeded" | "stopped" | "waiting";
  trigger?: "ask" | "run" | "schedule";
  via?: "app" | "cloud";
  slot?: string;
  late?: string;
  steps?: Step[];
  question?: { question: string; draft?: string };
  answeredAt?: string;
  iterations?: number;
  toolsUsed?: string[];
  judge?: { tier: string; promptTokens: number; outputTokens: number; ceilingUsd: number };
}
interface Schedule {
  every: "hour" | "day" | "week";
  at: string;
  weekday?: number;
  timeZone: string;
  task?: string;
}
interface AgentDef {
  id: string;
  name: string;
  role: string;
  instructions: string;
  tier: "auto" | "light" | "standard" | "deep";
  memory: boolean;
  capUsd: number;
  tools: string[];
  schedule?: Schedule;
  monthUsd?: number;
  monthTokens?: number;
  monthListUsd?: number;
  /** Google's price per million for this agent's model; "" when CrewPoppy chooses per request. */
  price?: string;
  scheduleLine?: string;
  nextRunAt?: string;
}
interface State {
  cloud: CloudState;
  memory: MemoryInfo | null;
  memoryWired: boolean;
  runs?: RunRecord[];
  waiting?: RunRecord[];
  model?: ModelState;
  timeZone?: string;
}
const TIER_WORDS: Record<RunRecord["tier"], string> = { none: "no model", light: "Gemini 2.5 Flash-Lite on Vertex AI", standard: "Gemini 2.5 Flash on Vertex AI", deep: "Gemini 2.5 Pro on Vertex AI" };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const money = (n: number): string => (n === 0 ? "$0.00" : `$${Math.max(0.01, Math.round(n * 100) / 100).toFixed(2)}`);
/** The crew's names for the page: the built-in members, and your own agents as last listed. */
const agentNames = new Map<string, string>([
]);
const nameOf = (id: string, name?: string): string => name ?? agentNames.get(id) ?? id;

function planLine(r: RunRecord): string {
  const parts = [`${TIER_WORDS[r.tier]} — ${r.why}`];
  if (r.read.purpose) parts.push(`${r.read.count} ${r.read.count === 1 ? "memory" : "memories"} read`);
  if (r.model) parts.push(`${(r.model.promptTokens + r.model.outputTokens).toLocaleString("en-GB")} tokens (${r.model.promptTokens.toLocaleString("en-GB")} in, ${r.model.outputTokens.toLocaleString("en-GB")} out)${r.model.listUsd !== undefined ? ` ≈ ${usdFine(r.model.listUsd)} at Google's price` : ""}${r.model.price ? ` — ${r.model.price}` : ""}`);
  else if (r.tier === "none") parts.push("no tokens");
  return `${parts.join(" · ")}.`;
}
function runReadLine(r: RunRecord): string {
  if (!r.read.purpose) return "Nothing read from your memory — the request was not about your life.";
  const kb = r.read.bytes >= 1024 ? `${(r.read.bytes / 1024).toFixed(1)} KB` : `${r.read.bytes} B`;
  return `Read ${r.read.count} ${r.read.count === 1 ? "memory" : "memories"} for ${r.read.purpose} — ${kb}. Written on your Activity${r.read.receipts.length ? ` (${r.read.receipts.length} ${r.read.receipts.length === 1 ? "receipt" : "receipts"})` : ""}.`;
}
/** "ran by itself · 09:31, late" / "asked" / "waiting for your answer" — how a run came about, and where it stands. */
function runStatusLine(r: RunRecord): string {
  const how = r.trigger === "schedule" ? (r.via === "cloud" ? "ran by itself in your cloud" : "ran by itself") : r.trigger === "run" ? `you ran ${nameOf(r.agent, r.agentName)}` : "asked";
  const state = r.status === "waiting" ? "waiting for your answer" : r.status === "stopped" ? "stopped" : r.status === "running" ? "running" : "";
  return [how, state, r.late].filter(Boolean).join(" · ");
}
function stepsHtml(r: RunRecord): string {
  if (!r.steps || r.steps.length === 0) return "";
  const kindWords: Record<Step["kind"], string> = { model: "wrote", tool: "used", result: "got", asked: "asked you", stopped: "stopped" };
  return `<details><summary>What it did — ${r.steps.length} ${r.steps.length === 1 ? "step" : "steps"}${r.iterations ? `, ${r.iterations} ${r.iterations === 1 ? "turn" : "turns"}` : ""}</summary><ol class="steps">${r.steps.map((s) => `<li><span class="mono">${esc(kindWords[s.kind])}</span> ${esc(s.text)}</li>`).join("")}</ol></details>`;
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
  if (!m.available) return "No memory poppy is installed yet — install MemoryPoppy, and your agents have something to read.";
  const words = (m.reads ?? []).map((k) => (k === "event" ? "meetings" : k === "person" ? "people" : k)).join(" and ");
  return `May read ${words || "nothing"} from ${m.provider?.name ?? "your memory poppy"} — only when a run is about your life, with a receipt each time.`;
}
/** "$0.0003" under a cent, "$0.03" above — a tiny amount read honestly. */
function usdFine(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${(Math.round(amount * 100) / 100).toFixed(2)}`;
}

// ---- tabs
const TABS = ["today", "crew", "briefs", "feedback"] as const;
for (const tab of document.querySelectorAll<HTMLElement>("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll<HTMLElement>("[role=tab]")) t.setAttribute("aria-selected", String(t === tab));
    for (const s of TABS) $(`tab-${s}`).hidden = s !== tab.dataset.tab;
    if (tab.dataset.tab === "crew") {
      void renderAgents();
      if (!templatesShown) void renderTemplates();
    }
  });
}

// ---- today
let settleTimer: number | undefined;
let ownZone = "";
let openedOnce = false;
function renderModel(m: ModelState | undefined): void {
  const sw = $<HTMLInputElement>("model-switch");
  if (!m || !m.available) {
    $("model-panel").hidden = true;
    return;
  }
  $("model-panel").hidden = false;
  sw.checked = m.enabled;
  $("model-label").textContent = m.enabled ? `On: your agents write with ${m.words} and its siblings, inside this project — billed to your Google Cloud, with a hard stop set by CrewPoppy.` : "Off: no agent runs and nothing is billed until you switch it on again.";
  $("meter").textContent = m.meter;
  if (m.tiers) {
    for (const t of m.tiers) tierPrices.set(t.tier, t.price);
    $<HTMLSelectElement>("agent-tier").dispatchEvent(new Event("change"));
  }
}
async function refresh(): Promise<void> {
  try {
    const state = await host.invokeBackend<State>({ method: "GET", path: "/state" });
    ownZone = state.timeZone ?? "";
    setStatus("where", describeCloud(state.cloud), state.cloud?.state === "failed" ? "warn" : "");
    $("memory-line").textContent = describeMemory(state.memory, state.memoryWired);
    if (state.cloud && (state.cloud.state === "setting-up" || state.cloud.state === "starting")) {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => void refresh(), 3000);
      setStatus("where", "Your crew's project is being set up. This takes about a minute the first time.");
      return;
    }
    if (!templatesShown) void renderTemplates();
    if (!openedOnce) {
      openedOnce = true;
      void renderAway();
    }
    renderWaiting(state.waiting ?? []);
    renderHistory(state.runs ?? []);
    renderModel(state.model);
  } catch (err) {
    setStatus("where", `Couldn't reach your crew: ${plainError(err)}`, "warn");
  }
}

// ---- ask your crew

// ---- while you were away (G4): the cloud job's runs since the last open
async function renderAway(): Promise<void> {
  try {
    const r = await host.invokeBackend<{ away: RunRecord[] }>({ method: "POST", path: "/opened" });
    const panel = $("away-panel");
    panel.hidden = r.away.length === 0;
    $("away").innerHTML = r.away
      .map((x) => `<div class="item"><div class="brief-when">${esc(when(x.at))} · ${esc(nameOf(x.agent, x.agentName))} · ${esc(runStatusLine(x))}</div>
        ${x.status === "waiting" ? `<div class="status">Asked: ${esc(x.question?.question ?? "")} — answer it below.</div>` : `<div class="brief" style="font-size:13px;margin:0">${esc(x.answer || x.note || "")}</div>`}</div>`)
      .join("");
  } catch {
    /* a bare build, or the store not ready yet — the next open will say */
  }
}

// ---- the runs waiting for you (G3c: ask_user)
function renderWaiting(runs: RunRecord[]): void {
  const panel = $("waiting-panel");
  const el = $("waiting");
  panel.hidden = runs.length === 0;
  el.innerHTML = runs
    .map(
      (r) => `<div class="waiting" data-wait="${esc(r.id)}">
        <div class="brief-when">${esc(when(r.at))} · ${esc(nameOf(r.agent, r.agentName))} · ${esc(r.request.length > 120 ? `${r.request.slice(0, 120)}…` : r.request)}</div>
        <p class="question">${esc(r.question?.question ?? "")}</p>
        ${r.question?.draft ? `<pre class="draft">${esc(r.question.draft)}</pre>` : ""}
        <textarea class="wait-answer" rows="2" placeholder="Your answer — a word is enough" aria-label="Your answer to ${esc(nameOf(r.agent, r.agentName))}"></textarea>
        <div class="row" style="margin-top:6px">
          <button class="btn" data-answer="${esc(r.id)}">Answer</button>
          <button class="ghost" data-stop-run="${esc(r.id)}">Stop this run</button>
        </div>
        <div class="answer" data-wait-answer="${esc(r.id)}"></div>
        <div class="receipt" data-wait-plan="${esc(r.id)}"></div>
        <div class="status" data-wait-status="${esc(r.id)}"></div>
      </div>`,
    )
    .join("");
  const q = (sel: string): HTMLElement => el.querySelector<HTMLElement>(sel)!;
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-answer]")) {
    const id = btn.dataset.answer ?? "";
    btn.addEventListener(
      "click",
      withPending(btn, "Continuing…", async () => {
        const answer = (q(`.waiting[data-wait="${id}"] .wait-answer`) as HTMLTextAreaElement).value.trim();
        if (!answer) {
          q(`[data-wait-status="${id}"]`).textContent = "Write an answer — a word is enough.";
          return;
        }
        q(`[data-wait-status="${id}"]`).textContent = "The agent is continuing…";
        try {
          const r = await host.invokeBackend<{ ok: boolean; run?: RunRecord; message?: string }>({ method: "POST", path: `/runs/${encodeURIComponent(id)}/answer`, body: { answer } });
          if (!r.ok || !r.run) {
            q(`[data-wait-status="${id}"]`).textContent = r.message ?? "It could not continue.";
            return;
          }
          if (r.run.status === "waiting") {
            await refresh();
            return;
          }
          q(`[data-wait-answer="${id}"]`).textContent = r.run.answer;
          q(`[data-wait-plan="${id}"]`).textContent = `${planLine(r.run)} ${runReadLine(r.run)}`;
          q(`[data-wait-status="${id}"]`).textContent = r.run.note ?? "Done — it is in History too.";
          q(`.waiting[data-wait="${id}"] .row`).hidden = true;
          (q(`.waiting[data-wait="${id}"] .wait-answer`) as HTMLTextAreaElement).disabled = true;
          void renderHistoryFromState();
        } catch (err) {
          q(`[data-wait-status="${id}"]`).textContent = plainError(err);
        }
      }),
    );
  }
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-stop-run]")) {
    const id = btn.dataset.stopRun ?? "";
    btn.addEventListener(
      "click",
      withPending(btn, "Stopping…", async () => {
        try {
          await host.invokeBackend({ method: "POST", path: `/runs/${encodeURIComponent(id)}/stop` });
          await refresh();
        } catch (err) {
          q(`[data-wait-status="${id}"]`).textContent = plainError(err);
        }
      }),
    );
  }
}
async function renderHistoryFromState(): Promise<void> {
  try {
    const h = await host.invokeBackend<{ runs: RunRecord[] }>({ method: "GET", path: "/history" });
    renderHistory(h.runs);
  } catch {
    /* the next refresh will */
  }
}

// ---- your own agents (G3b, with tools and schedules since G3c)
const TIER_LABEL: Record<AgentDef["tier"], string> = Object.fromEntries(FORM.tiers.map((t) => [t.value, t.label])) as Record<AgentDef["tier"], string>;
const TOOL_LABEL = new Map(FORM.tools.flatMap((g) => g.tools.map((t) => [t.value, t.label] as const)));

/** Google's price per million for each model, from the backend's state — shown beside the choice. */
const tierPrices = new Map<string, string>();
function fillTierSelect(): void {
  const sel = $<HTMLSelectElement>("agent-tier");
  sel.innerHTML = FORM.tiers.map((t) => `<option value="${t.value}">${esc(t.label)}</option>`).join("");
  const note = (): void => {
    const price = tierPrices.get(sel.value);
    $("agent-tier-note").textContent = `${FORM.tiers.find((t) => t.value === sel.value)?.note ?? ""}${price ? ` — ${price}` : ""}`;
  };
  sel.addEventListener("change", note);
  note();
}
fillTierSelect();
/** The tools, rendered from the same catalogue the helper prompt is built from. */
function fillTools(): void {
  $("agent-tools").innerHTML = FORM.tools
    .map(
      (g) => `<div class="tool-group"><div><strong>${esc(g.label)}</strong> <span class="muted small">— ${esc(g.what)}</span></div>
        ${g.tools.map((t) => `<label class="tool"><input type="checkbox" data-tool="${esc(t.value)}" ${t.default ? "checked" : ""} /> <span><span class="tool-label">${esc(t.label)}</span> <span class="muted small">${esc(t.what)}${t.risk ? ` ${esc(t.risk)}` : ""}</span></span></label>`).join("")}
      </div>`,
    )
    .join("");
  $("agent-memory-note").textContent = FORM.memory.note.charAt(0).toUpperCase() + FORM.memory.note.slice(1) + ".";
}
fillTools();
function fillScheduleSelects(): void {
  $<HTMLSelectElement>("agent-weekday").innerHTML = WEEKDAYS.map((d, i) => `<option value="${i}">${esc(d)}</option>`).join("");
  const every = $<HTMLSelectElement>("agent-every");
  const show = (): void => {
    $("agent-at-wrap").hidden = every.value !== "day" && every.value !== "week";
    $("agent-weekday-wrap").hidden = every.value !== "week";
    $("agent-task-wrap").hidden = every.value === "off";
    $("agent-schedule-note").textContent = every.value === "off" ? "Runs only when you press Run." : `${FORM.schedule.note.charAt(0).toUpperCase()}${FORM.schedule.note.slice(1)}.${ownZone ? ` Your clock: ${ownZone}.` : ""}`;
  };
  every.addEventListener("change", show);
  show();
}
fillScheduleSelects();
function setTools(tools: string[]): void {
  for (const box of document.querySelectorAll<HTMLInputElement>("#agent-tools input[data-tool]")) box.checked = tools.includes(box.dataset.tool ?? "");
}
function setSchedule(s: Schedule | undefined): void {
  ($("agent-every") as HTMLSelectElement).value = s?.every ?? "off";
  ($("agent-at") as HTMLInputElement).value = s && s.every !== "hour" ? s.at : "09:00";
  ($("agent-weekday") as HTMLSelectElement).value = String(s?.weekday ?? 1);
  ($("agent-task") as HTMLTextAreaElement).value = s?.task ?? "";
  ($("agent-every") as HTMLSelectElement).dispatchEvent(new Event("change"));
}
function resetAgentForm(): void {
  ($("agent-id") as HTMLInputElement).value = "";
  ($("agent-name") as HTMLInputElement).value = "";
  ($("agent-role") as HTMLInputElement).value = "";
  ($("agent-instructions") as HTMLTextAreaElement).value = "";
  ($("agent-tier") as HTMLSelectElement).value = "auto";
  ($("agent-tier") as HTMLSelectElement).dispatchEvent(new Event("change"));
  ($("agent-memory") as HTMLInputElement).checked = true;
  ($("agent-cap") as HTMLInputElement).value = String(FORM.cap.default);
  setTools(FORM.tools.flatMap((g) => g.tools.filter((t) => t.default).map((t) => t.value)));
  setSchedule(undefined);
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
  setTools(a.tools ?? []);
  setSchedule(a.schedule);
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
    const every = ($("agent-every") as HTMLSelectElement).value;
    const schedule = every === "off" ? null : { every, at: ($("agent-at") as HTMLInputElement).value, weekday: Number(($("agent-weekday") as HTMLSelectElement).value), timeZone: ownZone || undefined, task: ($("agent-task") as HTMLTextAreaElement).value };
    const body = {
      ...(id ? { id } : {}),
      name: ($("agent-name") as HTMLInputElement).value,
      role: ($("agent-role") as HTMLInputElement).value,
      instructions: ($("agent-instructions") as HTMLTextAreaElement).value,
      tier: ($("agent-tier") as HTMLSelectElement).value,
      memory: ($("agent-memory") as HTMLInputElement).checked,
      capUsd: Number(($("agent-cap") as HTMLInputElement).value),
      tools: [...document.querySelectorAll<HTMLInputElement>("#agent-tools input[data-tool]")].filter((b) => b.checked).map((b) => b.dataset.tool),
      schedule,
    };
    try {
      const r = await host.invokeBackend<{ agent: AgentDef }>({ method: "POST", path: "/agents", body });
      setStatus("agent-status", `${r.agent.name} is ${id ? "saved" : "in the crew"}${r.agent.scheduleLine ? ` — runs ${r.agent.scheduleLine}` : ""}.`);
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

/** "its own notes and files · asks you · searches your memory" */
function toolWords(a: AgentDef): string {
  const words: string[] = [];
  if (a.memory) words.push("may search your memory");
  const own = FORM.tools.find((g) => g.key === "own")?.tools.map((t) => t.value) ?? [];
  if ((a.tools ?? []).some((t) => own.includes(t as never))) words.push("its own notes and files");
  if ((a.tools ?? []).includes("ask_user")) words.push("asks you first");
  return words.length ? words.join(" · ") : "no tools — it only writes";
}

interface Template {
  key: string;
  name: string;
  role: string;
  blurb: string;
  needs: string[];
  notYet: string[];
  unavailable?: string;
  scheduleLine: string;
  files: string[];
}
/** The live app's recipes, as this edition offers them (DESIGN §18, one product with the live app). */
/** True once the cards are on the page; until then the crew tab and the first ready state ask again. */
let templatesShown = false;
async function renderTemplates(): Promise<void> {
  const el = $("templates");
  let templates: Template[] = [];
  try {
    templates = (await host.invokeBackend<{ templates: Template[] }>({ method: "GET", path: "/templates" })).templates;
  } catch (err) {
    el.innerHTML = `<div class="status warn">${esc(`The templates could not be read just now — ${plainError(err)} They will show when you open this tab again.`)}</div>`;
    return;
  }
  templatesShown = true;
  el.innerHTML = templates
    .map(
      (t) => `<div class="template">
        <div><strong>${esc(t.name)}</strong> <span class="muted">· ${esc(t.role)}</span></div>
        <div class="muted small" style="margin:4px 0">${esc(t.blurb)}</div>
        ${t.scheduleLine ? `<div class="muted small">Runs ${esc(t.scheduleLine)}.</div>` : ""}
        ${t.files.length ? `<div class="muted small">Comes with ${esc(t.files.join(", "))}.</div>` : ""}
        ${t.notYet.length ? `<div class="muted small">Not on Google yet: ${esc(t.notYet.join(", "))} — it writes a file instead and says so.</div>` : ""}
        <div class="row" style="margin-top:6px">${t.unavailable ? `<span class="muted small">Coming to this edition — ${esc(t.unavailable)}.</span>` : `<button class="ghost" data-activate="${esc(t.key)}">Add ${esc(t.name)} to the crew</button>`}</div>
      </div>`,
    )
    .join("");
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-activate]")) {
    const key = btn.dataset.activate ?? "";
    btn.addEventListener(
      "click",
      withPending(btn, "Adding…", async () => {
        try {
          const r = await host.invokeBackend<{ agent: AgentDef; files: string[] }>({ method: "POST", path: `/templates/${key}/activate` });
          setStatus("templates-status", `${r.agent.name} is in the crew${r.agent.scheduleLine ? ` — runs ${r.agent.scheduleLine}` : ""}${r.files.length ? `, with ${r.files.join(", ")}` : ""}. Edit the brief any time.`);
          await renderAgents();
        } catch (err) {
          setStatus("templates-status", plainError(err), "warn");
        }
      }),
    );
  }
}

async function renderAgents(): Promise<void> {
  const el = $("agents");
  let agents: AgentDef[] = [];
  try {
    agents = (await host.invokeBackend<{ agents: AgentDef[] }>({ method: "GET", path: "/agents" })).agents;
  } catch (err) {
    el.innerHTML = `<div class="status warn">${esc(`Couldn't read your agents: ${plainError(err)}`)}</div>`;
    return;
  }
  for (const a of agents) agentNames.set(a.id, a.name);
  if (agents.length === 0) {
    el.innerHTML = `<div class="muted small" style="margin:6px 0 10px">No agents yet. Start from a template below, or make your own.</div>`;
    return;
  }
  el.innerHTML = agents
    .map(
      (a) => `<div class="agent" data-id="${esc(a.id)}">
        <div class="row" style="justify-content:space-between">
          <div><strong>${esc(a.name)}</strong> <span class="muted">· ${esc(a.role)}</span></div>
          <span class="muted small">${esc(TIER_LABEL[a.tier] ?? a.tier)}${a.price ? ` (${esc(a.price)})` : ""} · this month ${a.monthTokens ? `${esc(a.monthTokens.toLocaleString("en-GB"))} tokens ≈ ${esc(usdFine(a.monthListUsd ?? 0))} at Google's price` : a.monthUsd ? "tokens counted from today" : "no tokens yet"} · stops at ${esc(money(a.capUsd))} on the safety ceiling</span>
        </div>
        <div class="muted small">${esc(toolWords(a))}${a.scheduleLine ? ` · runs ${esc(a.scheduleLine)}${a.nextRunAt ? `, next ${esc(when(a.nextRunAt))}` : ""}` : ""}</div>
        <div class="muted small">${esc(a.instructions.length > 220 ? `${a.instructions.slice(0, 220)}…` : a.instructions)}</div>
        <div class="run">
          <textarea class="agent-request" rows="2" placeholder="Anything for this run? Leave empty and ${esc(a.name)} does the job as briefed." aria-label="Request for ${esc(a.name)}"></textarea>
          <div class="row" style="margin-top:6px">
            <button class="btn" data-run="${esc(a.id)}">Run ${esc(a.name)}</button>
            <button class="ghost" data-edit="${esc(a.id)}">Edit</button>
            <button class="ghost danger-text" data-remove="${esc(a.id)}">Remove</button>
          </div>
          <div class="confirm" data-confirm="${esc(a.id)}" hidden>
            <p style="margin:0 0 8px">Remove ${esc(a.name)} from the crew? Its brief, its notes and its files go; its past runs stay in History. This can't be undone.</p>
            <div class="row"><button class="ghost" data-keep="${esc(a.id)}">Keep</button><button class="btn danger" data-remove-yes="${esc(a.id)}">Remove ${esc(a.name)}</button></div>
          </div>
          <div class="answer" data-answer="${esc(a.id)}"></div>
          <div class="receipt" data-plan="${esc(a.id)}"></div>
          <div data-steps="${esc(a.id)}"></div>
          <div class="status" data-status="${esc(a.id)}"></div>
        </div>
      </div>`,
    )
    .join("");
  const q = (sel: string): HTMLElement => el.querySelector<HTMLElement>(sel)!;
  const showRun = (id: string, r: RunRecord): void => {
    q(`[data-answer="${id}"]`).textContent = r.answer;
    q(`[data-plan="${id}"]`).textContent = `${planLine(r)} ${runReadLine(r)}`;
    q(`[data-steps="${id}"]`).innerHTML = stepsHtml(r);
    q(`[data-status="${id}"]`).textContent = r.status === "waiting" ? `${nameOf(r.agent, r.agentName)} asked you something — answer it under Today.` : (r.note ?? "");
  };
  for (const btn of el.querySelectorAll<HTMLButtonElement>("button[data-run]")) {
    const id = btn.dataset.run ?? "";
    btn.addEventListener(
      "click",
      withPending(btn, "Running…", async () => {
        const request = (q(`.agent[data-id="${id}"] .agent-request`) as HTMLTextAreaElement).value.trim();
        q(`[data-status="${id}"]`).textContent = "Reading and judging the request…";
        try {
          const r = await host.invokeBackend<{ ok: boolean; run?: RunRecord; message?: string; agent?: AgentDef }>({ method: "POST", path: `/agents/${encodeURIComponent(id)}/run`, body: { request } });
          if (!r.ok || !r.run) {
            q(`[data-status="${id}"]`).textContent = r.message ?? "It did not run.";
            return;
          }
          const run = r.run;
          showRun(id, run);
          await refresh();
          await renderAgents();
          showRun(id, run);
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

// ---- the Crew Pack (G3c): the crew's knowledge as one file, out and back
$<HTMLButtonElement>("btn-export-pack").addEventListener(
  "click",
  withPending($("btn-export-pack"), "Preparing…", async () => {
    try {
      const conn = await host.getConnection();
      const { path, filename } = await host.invokeBackend<{ path: string; filename: string }>({ method: "POST", path: "/export-token" });
      // The host's browser fetches the one-shot download through the broker — our own origin here.
      await host.openExternal(`${location.origin}/ext-dl/${encodeURIComponent(conn.app.id)}${path}`);
      setStatus("pack-status", `Your browser is saving ${filename}.`);
    } catch (err) {
      setStatus("pack-status", `Couldn't prepare the download: ${plainError(err)}`, "warn");
    }
  }),
);
$<HTMLButtonElement>("btn-import-pack").addEventListener(
  "click",
  withPending($("btn-import-pack"), "Bringing it in…", async () => {
    const file = ($("pack-file") as HTMLInputElement).files?.[0];
    if (!file) {
      setStatus("pack-status", "Choose a Crew Pack file first.");
      return;
    }
    try {
      const pack = JSON.parse(await file.text()) as unknown;
      const r = await host.invokeBackend<{ line: string; report: { skipped: string[] } }>({ method: "POST", path: "/crew-pack", body: { pack } });
      setStatus("pack-status", r.report.skipped.length ? `${r.line} Left out: ${r.report.skipped.join("; ")}` : r.line);
      ($("pack-file") as HTMLInputElement).value = "";
      await renderAgents();
    } catch (err) {
      setStatus("pack-status", err instanceof SyntaxError ? "That file is not JSON — a Crew Pack is the file CrewPoppy exported." : plainError(err), "warn");
    }
  }),
);

// ---- the model switch: reacts at once, and says what happened
$<HTMLInputElement>("model-switch").addEventListener("change", async (e) => {
  const sw = e.target as HTMLInputElement;
  const wanted = sw.checked;
  sw.disabled = true;
  setStatus("model-status", wanted ? "Switching the model on…" : "Switching the model off…");
  try {
    const r = await host.invokeBackend<{ model: ModelState }>({ method: "POST", path: "/settings", body: { model: wanted } });
    renderModel(r.model);
    setStatus("model-status", wanted ? "On. The crew writes with the model again." : "Off. No agent runs and nothing is billed until you switch it on again.");
  } catch (err) {
    sw.checked = !wanted;
    setStatus("model-status", `Couldn't change that: ${plainError(err)}`, "warn");
  } finally {
    sw.disabled = false;
  }
});

// ---- history
function renderHistory(runs: RunRecord[] = []): void {
  const el = $("history");
  const items = [
    ...runs.map((r) => ({
      at: r.at,
      html: `<div class="brief-when">${esc(when(r.at))} · ${esc(runStatusLine(r))}</div>
        <div class="muted small">${esc(r.request.length > 200 ? `${r.request.slice(0, 200)}…` : r.request)}</div>
        ${r.status === "waiting" ? `<div class="status">${esc(nameOf(r.agent, r.agentName))} asked: ${esc(r.question?.question ?? "")} — answer it under Today.</div>` : `<div class="brief" style="font-size:13px">${esc(r.answer)}</div>`}
        <div class="receipt">${esc(planLine(r))}</div>
        <div class="receipt">${esc(runReadLine(r))}</div>${r.note ? `<div class="status">${esc(r.note)}</div>` : ""}${stepsHtml(r)}`,
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
void renderTemplates();
void renderAgents();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
// While a schedule may be running by itself, the page looks again every minute.
window.setInterval(() => {
  if (document.visibilityState === "visible") void refresh();
}, 60_000);
