// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * ONE ticker for the whole crew (DESIGN.md §5b): every minute, while CrewPoppy is open, it looks
 * for agents whose schedule is due and runs each one once per slot. A schedule is data on the
 * agent; there is nothing to provision and nothing to leak. Runs that must outlive the app —
 * Cloud Run jobs and Cloud Scheduler — wait on a decision the founder owns (§18, G3c).
 */
import { MAX_RUN_MS } from "./loop";
import { type RunDeps, runAgent } from "./runner";
import { LATE_AFTER_MS, LATE_WINDOW_MS, clockIn, lastSlot } from "./schedule";

/** The run id of a slot — a pure function of the agent and the slot, never of "now" — so a slot runs once. */
export function scheduledRunId(agentId: string, slot: string): string {
  return `${agentId}~${slot.replace(/[^0-9A-Za-z]/g, "")}`;
}

export interface TickReport {
  ran: string[];
  skipped: string[];
}

export interface TickOptions {
  /** True in the cloud job: the app is closed, so an agent that needs the memory waits for it unless a door is there. */
  away?: boolean;
}

export const NEEDS_APP = "needs CrewPoppy open — your memory is reachable only through AgentsPoppy";

export async function tick(deps: RunDeps, busy: Set<string>, opts: TickOptions = {}): Promise<TickReport> {
  const report: TickReport = { ran: [], skipped: [] };
  if (!deps.store.ready) return report;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const nowMs = Date.parse(now);
  for (const agent of await deps.store.agents()) {
    if (!agent.schedule) continue;
    const due = lastSlot(agent.schedule, now);
    const age = nowMs - Date.parse(due.dueAt);
    if (age > LATE_WINDOW_MS) continue;
    // A slot that was due before the schedule was set (or the agent last saved) is not owed.
    if (Date.parse(due.dueAt) < Date.parse(agent.updatedAt)) continue;
    const id = scheduledRunId(agent.id, due.slot);
    if (busy.has(agent.id)) continue;
    if (await deps.store.run(id)) continue;
    if (opts.away && agent.memory && !deps.memory) {
      // Said once, on the slot, not every five minutes: the app runs it when it opens (within the late window).
      await deps.store.saveRun({ id, at: now, agent: agent.id, agentName: agent.name, via: deps.via ?? "cloud", request: `(${agent.name}'s brief)`, tier: agent.tier === "auto" ? "standard" : agent.tier, why: "its schedule", choice: "auto", answer: "", read: { count: 0, bytes: 0, receipts: [], purpose: "" }, status: "stopped", trigger: "schedule", slot: due.slot, note: `${agent.name} did not run here: ${NEEDS_APP}.` }).catch(() => {});
      report.skipped.push(`${agent.name}: ${NEEDS_APP}`);
      continue;
    }
    const active = await deps.store.activeRun(agent.id);
    if (active) {
      // A run the app was closed in the middle of would block its agent forever; say so and move on.
      if (active.status === "running" && nowMs - Date.parse(active.at) > MAX_RUN_MS * 2) {
        await deps.store.saveRun({ ...active, status: "stopped", note: `${agent.name} stopped: CrewPoppy was closed during this run.` }).catch(() => {});
      } else {
        report.skipped.push(`${agent.name}: ${active.status === "waiting" ? "still waiting for your answer" : "still running"}`);
        continue;
      }
    }
    const late = age > LATE_AFTER_MS ? `ran at ${clockIn(agent.schedule.timeZone, now)} instead of ${agent.schedule.every === "hour" ? "the hour" : agent.schedule.at} — CrewPoppy was not open at the time` : undefined;
    busy.add(agent.id);
    try {
      const r = await runAgent(deps, agent, "", { trigger: "schedule", slot: due.slot, id, ...(late ? { late } : {}) });
      report.ran.push(`${agent.name} (${due.slot})${r.ok ? "" : ` — ${r.message}`}`);
      if (!r.ok) {
        // A refused start (a cap, the model off) is recorded on the slot too, so it is not retried every minute.
        await deps.store.saveRun({ id, at: now, agent: agent.id, agentName: agent.name, via: deps.via ?? "app", request: `(${agent.name}'s brief)`, tier: agent.tier === "auto" ? "standard" : agent.tier, why: "its schedule", choice: "auto", answer: "", read: { count: 0, bytes: 0, receipts: [], purpose: "" }, status: "stopped", trigger: "schedule", slot: due.slot, note: r.message }).catch(() => {});
      }
    } catch (e) {
      deps.log?.(`scheduled run of ${agent.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy.delete(agent.id);
    }
  }
  return report;
}

export function startTicker(deps: RunDeps, opts: { everyMs?: number; firstAfterMs?: number } = {}): () => void {
  const busy = new Set<string>();
  const log = deps.log ?? (() => {});
  const once = (): void => {
    void tick(deps, busy).then(
      (r) => {
        if (r.ran.length > 0) log(`ticker ran ${r.ran.join(", ")}`);
      },
      (e) => log(`ticker failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  const first = setTimeout(once, opts.firstAfterMs ?? 5_000);
  const timer = setInterval(once, opts.everyMs ?? 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
