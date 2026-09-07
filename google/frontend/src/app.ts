// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The Crew HQ on Google Cloud, first release (DESIGN.md §18): Today (the brief), Your crew, Past
 * briefs, Feedback. Talks to the host over the capability-gated bridge (inlined, as the AWS
 * edition's host.ts does) and to our own backend through the host. Every button reacts the
 * instant it is pressed; every error is one calm sentence.
 */
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
}
interface State {
  cloud: CloudState;
  memory: MemoryInfo | null;
  memoryWired: boolean;
  briefs: BriefRecord[];
  purpose: string;
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
    return;
  }
  $("brief-when").textContent = `Written ${when(b.at)}`;
  $("brief").className = "brief";
  $("brief").textContent = b.text;
  $("receipt").textContent = readLine(b);
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
    renderHistory(state.briefs);
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

// ---- history
function renderHistory(briefs: BriefRecord[]): void {
  const el = $("history");
  if (briefs.length === 0) {
    el.className = "history muted";
    el.textContent = "No briefs yet.";
    return;
  }
  el.className = "history";
  el.innerHTML = briefs
    .map(
      (b) => `<div class="item">
        <div class="brief-when">${esc(when(b.at))}</div>
        <div class="brief" style="font-size:13px">${esc(b.text)}</div>
        <details><summary>What was read</summary><div class="receipt">${esc(readLine(b))}</div>
          <ul class="plain">${b.memoryIds.map((id) => `<li class="mono">${esc(id)}</li>`).join("")}</ul></details>
      </div>`,
    )
    .join("");
}

void refresh();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
