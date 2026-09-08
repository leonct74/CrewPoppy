// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * Job mode (DESIGN.md §18 G4a): the same backend, started by Cloud Scheduler inside the poppy's
 * own project while CrewPoppy is closed. No host: the identity comes from Google's metadata
 * server (the process IS the poppy's service account, with exactly its role), the store opens as
 * at home, the due slots run once through the same ticker with the same slot-derived ids, and the
 * process exits. Waiting runs stay waiting for the app; an agent that may read the memory runs
 * only when the provider's door is there.
 */
import type { RunDeps } from "./runner";
import { type TickReport, tick } from "./scheduler";

/** What the host puts in the job's environment when it provisions the runner (G4b). */
export interface CloudBootstrap {
  connectionId: string;
  appId: string;
  timeZone?: string;
  /** The memory poppy's door, once the user allowed reads while the app is closed (G4c). */
  memoryDoor?: { url: string; audience?: string };
}

export const CLOUD_BOOTSTRAP_ENV = "AGENTSPOPPY_CLOUD_BOOTSTRAP";

export function readCloudBootstrap(env: NodeJS.ProcessEnv = process.env): CloudBootstrap | null {
  const raw = env[CLOUD_BOOTSTRAP_ENV];
  if (!raw) return null;
  const b = JSON.parse(raw) as Partial<CloudBootstrap>;
  if (typeof b.connectionId !== "string" || typeof b.appId !== "string") throw new Error(`${CLOUD_BOOTSTRAP_ENV} must carry connectionId and appId`);
  return { connectionId: b.connectionId, appId: b.appId, ...(b.timeZone ? { timeZone: b.timeZone } : {}), ...(b.memoryDoor?.url ? { memoryDoor: { url: b.memoryDoor.url, ...(b.memoryDoor.audience ? { audience: b.memoryDoor.audience } : {}) } } : {}) };
}

export interface JobReport extends TickReport {
  /** Why nothing ran, when nothing could. */
  reason?: string;
}

/** One pass: open the store, run what is due, report. The caller exits. */
export async function runJob(deps: RunDeps): Promise<JobReport> {
  const log = deps.log ?? (() => {});
  const state = await deps.store.open();
  if (state.state !== "ready") {
    const reason = deps.store.unavailableMessage();
    log(`job: the store did not open — ${reason}`);
    return { ran: [], skipped: [], reason };
  }
  const report = await tick(deps, new Set(), { away: true });
  log(`job: ran ${report.ran.length} (${report.ran.join(", ") || "none"}), skipped ${report.skipped.length} (${report.skipped.join(", ") || "none"})`);
  return report;
}
