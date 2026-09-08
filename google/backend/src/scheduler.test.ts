// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { AgentDef } from "./agents";
import type { RunDeps } from "./runner";
import { scheduledRunId, tick } from "./scheduler";
import { CrewStore, type RunRecord } from "./store";
import { FakeWire, scriptedModel } from "./testing";

const emma: AgentDef = { id: "emma", name: "Emma", role: "Briefer of the day", instructions: "Write the day's note.", tier: "light", memory: false, capUsd: 2, tools: ["note_read"], schedule: { every: "day", at: "09:00", timeZone: "Europe/Rome" }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };

async function world(now: string, script = [{ text: "Today's note." }]) {
  const wire = new FakeWire();
  const store = new CrewStore({ wire, now: () => now, timeZone: () => "Europe/Rome" });
  await store.open();
  await store.saveAgent(emma);
  const model = scriptedModel(script);
  let ids = 0;
  const deps: RunDeps = { store, memory: null, model, now: () => now, timeZone: () => "Europe/Rome", newId: () => `id-${++ids}` };
  return { wire, store, model, deps };
}

describe("the ticker", () => {
  it("runs a due agent once per slot — the run id is the slot's — and says when the app was closed at the time", async () => {
    const { wire, deps, model } = await world("2026-09-08T07:31:00.000Z");
    const first = await tick(deps, new Set());
    expect(first.ran).toEqual(["Emma (2026-09-08T0900)"]);
    const id = scheduledRunId("emma", "2026-09-08T0900");
    expect(id).toBe("emma~20260908T0900");
    const run = wire.col("runs").get(id) as RunRecord;
    expect(run).toMatchObject({ status: "succeeded", trigger: "schedule", slot: "2026-09-08T0900", answer: "Today's note.", late: "ran at 09:31 instead of 09:00 — CrewPoppy was not open at the time", request: "(Emma's brief)" });
    expect(model.requests).toHaveLength(1);
    const second = await tick(deps, new Set());
    expect(second.ran).toEqual([]);
    expect(wire.col("runs").size).toBe(1);
    // On time: no late note.
    const onTime = await world("2026-09-08T07:02:00.000Z");
    await tick(onTime.deps, new Set());
    expect((onTime.wire.col("runs").get(id) as RunRecord).late).toBeUndefined();
  });

  it("lets an old slot go, owes nothing from before the schedule was set, never stacks on a run that waits for you, and frees an agent the app was closed on", async () => {
    const old = await world("2026-09-09T05:00:00.000Z");
    expect((await tick(old.deps, new Set())).ran).toEqual([]);
    expect(old.wire.col("runs").size).toBe(0);

    // Saved at 09:31 with "every day at 09:00": today's 09:00 was before the save, so it is not owed.
    const fresh = await world("2026-09-08T07:31:00.000Z");
    await fresh.store.saveAgent({ ...emma, updatedAt: "2026-09-08T07:31:00.000Z" });
    expect((await tick(fresh.deps, new Set())).ran).toEqual([]);
    expect(fresh.wire.col("runs").size).toBe(0);

    const waiting = await world("2026-09-08T07:31:00.000Z");
    await waiting.store.saveRun({ id: "w1", at: "2026-09-08T07:00:00.000Z", agent: "emma", request: "x", tier: "light", why: "w", choice: "auto", answer: "", read: { count: 0, bytes: 0, receipts: [], purpose: "" }, status: "waiting", question: { question: "Go?" }, conversation: "[]" });
    expect(await tick(waiting.deps, new Set())).toEqual({ ran: [], skipped: ["Emma: still waiting for your answer"] });

    const stale = await world("2026-09-08T07:31:00.000Z");
    await stale.store.saveRun({ id: "s1", at: "2026-09-08T07:10:00.000Z", agent: "emma", request: "x", tier: "light", why: "w", choice: "auto", answer: "", read: { count: 0, bytes: 0, receipts: [], purpose: "" }, status: "running" });
    expect((await tick(stale.deps, new Set())).ran).toEqual(["Emma (2026-09-08T0900)"]);
    expect((stale.wire.col("runs").get("s1") as RunRecord)).toMatchObject({ status: "stopped", note: "Emma stopped: CrewPoppy was closed during this run." });

    const busy = await world("2026-09-08T07:31:00.000Z");
    expect((await tick(busy.deps, new Set(["emma"]))).ran).toEqual([]);
  });

  it("records a refused start on the slot, so a capped agent is not retried every minute", async () => {
    const { wire, deps } = await world("2026-09-08T07:31:00.000Z");
    const capped = { ...deps, caps: { callsPerDay: 0, callsPerMonth: 1, tokensPerMonth: 1, usdPerMonth: 1 } };
    const r = await tick(capped, new Set());
    expect(r.ran).toEqual(["Emma (2026-09-08T0900) — Emma did not run: today's limit of 0 model calls is reached."]);
    const run = wire.col("runs").get(scheduledRunId("emma", "2026-09-08T0900")) as RunRecord;
    expect(run).toMatchObject({ status: "stopped", trigger: "schedule", note: "Emma did not run: today's limit of 0 model calls is reached." });
    expect((await tick(capped, new Set())).ran).toEqual([]);
  });

  it("hands the schedule's task to the agent as the run's request — its brief when there is none", async () => {
    const { wire, store, deps, model } = await world("2026-09-08T07:02:00.000Z");
    await store.saveAgent({ ...emma, schedule: { ...emma.schedule!, task: "Thank the people I met today." } });
    await tick(deps, new Set());
    const run = wire.col("runs").get(scheduledRunId("emma", "2026-09-08T0900")) as RunRecord;
    expect(run).toMatchObject({ status: "succeeded", request: "Thank the people I met today." });
    expect(JSON.stringify(model.requests[0])).toContain("Thank the people I met today.");
  });
});
