// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { Memory, MemoryPage } from "@agentspoppy/core";
import type { FirestoreWire, IndexField, WireDoc, WireWrite } from "./firestore";
import { type MemoryReader, PURPOSE, describeRead, handle } from "./routes";
import { CrewStore } from "./store";

class FakeWire implements FirestoreWire {
  readonly docs = new Map<string, Map<string, object>>();
  col(c: string): Map<string, object> {
    let m = this.docs.get(c);
    if (!m) this.docs.set(c, (m = new Map()));
    return m;
  }
  async projectId(): Promise<string> {
    return "poppy-com-crewpoppy-fake";
  }
  async ensureDatabase(region: string): Promise<{ created: boolean; locationId: string }> {
    return { created: true, locationId: region };
  }
  async ensureIndex(_c: string, _f: IndexField[]): Promise<void> {}
  async get<T>(c: string, id: string): Promise<T | null> {
    return (this.col(c).get(id) as T | undefined) ?? null;
  }
  async set(c: string, id: string, data: object): Promise<void> {
    this.col(c).set(id, structuredClone(data));
  }
  async commit(writes: WireWrite[]): Promise<void> {
    for (const w of writes) this.col(w.collection).set(w.id, structuredClone(w.data));
  }
  async listChanged<T>(c: string): Promise<WireDoc<T>[]> {
    return [...this.col(c).entries()].map(([id, data]) => ({ id, data: data as T }));
  }
}

const NOW = "2026-09-08T06:30:00.000Z";
const prov = { app: "com.agentspoppy.memory", source: "calendar" as const, capturedAt: NOW };
const anna: Memory = { id: "p1", kind: "person", title: "Anna Rossi", provenance: prov, confidence: 0.8, createdAt: NOW, updatedAt: NOW, visibility: "shared", status: "active" };
const board: Memory = {
  id: "e1",
  kind: "event",
  title: "Board meeting",
  attributes: { start: "2026-09-08T07:00:00Z", end: "2026-09-08T08:30:00Z", allDay: false },
  links: [{ to: "p1", relation: "with" }],
  provenance: prov,
  confidence: 0.9,
  observedAt: "2026-09-08T07:00:00Z",
  createdAt: NOW,
  updatedAt: NOW,
  visibility: "shared",
  status: "active",
};

/** The host's memory route, as the Briefer sees it: every call recorded, receipts handed back. */
function fakeMemory(): MemoryReader & { calls: Array<{ path: string; req: unknown }> } {
  const calls: Array<{ path: string; req: unknown }> = [];
  return {
    calls,
    async status() {
      calls.push({ path: "status", req: undefined });
      return { available: true, provider: { app: "com.agentspoppy.memory", name: "MemoryPoppy" }, reads: ["person", "event"], writes: [], sensitive: false };
    },
    async search(req) {
      calls.push({ path: "search", req });
      const page: MemoryPage = { memories: [board], truncated: false, receipt: "receipt-search-1" };
      return page;
    },
    async get(req) {
      calls.push({ path: "get", req });
      return { memories: [anna], truncated: false, receipt: "receipt-get-1" };
    },
  };
}

async function ready(): Promise<{ store: CrewStore; wire: FakeWire }> {
  const wire = new FakeWire();
  const store = new CrewStore({ wire, now: () => NOW, timeZone: () => "Europe/Rome" });
  await store.open();
  return { store, wire };
}

describe("the Crew HQ routes", () => {
  it("/state tells what the memory poppy allows and where the crew's records live", async () => {
    const { store } = await ready();
    const r = await handle("/state", "GET", undefined, { store, memory: fakeMemory(), now: () => NOW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, cloud: { state: "ready", region: "eur3" }, memory: { available: true, reads: ["person", "event"] }, briefs: [], purpose: PURPOSE });
  });

  it("/brief reads the week's meetings through the host for the named purpose, then their people, writes the brief and keeps it with its receipts", async () => {
    const { store, wire } = await ready();
    const memory = fakeMemory();
    const r = await handle("/brief", "POST", undefined, { store, memory, now: () => NOW, timeZone: () => "Europe/Rome", newId: () => "b1" });
    expect(r.status).toBe(200);
    const body = r.body as { brief: { text: string; receipts: string[]; memoryIds: string[]; read: unknown }; readLine: string };
    expect(memory.calls[0]).toMatchObject({ path: "search", req: { purpose: PURPOSE, kinds: ["event"], since: "2026-09-01T06:30:00.000Z", until: "2026-09-15T06:30:00.000Z", limit: 40 } });
    expect(memory.calls[1]).toMatchObject({ path: "get", req: { purpose: PURPOSE, ids: ["p1"] } });
    expect(body.brief.text).toContain("Board meeting with Anna Rossi");
    expect(body.brief.receipts).toEqual(["receipt-search-1", "receipt-get-1"]);
    expect(body.brief.memoryIds.sort()).toEqual(["e1", "p1"]);
    expect(body.brief.read).toMatchObject({ events: 1, people: 1 });
    expect(body.readLine).toMatch(/^Read 1 meeting and 1 person for “Morning briefing” — [\d.]+ (B|KB)\.$/);
    expect(wire.col("briefs").get("b1")).toMatchObject({ id: "b1", purpose: PURPOSE, receipts: ["receipt-search-1", "receipt-get-1"] });
    const list = (await handle("/briefs", "GET", undefined, { store, memory })).body as { briefs: unknown[] };
    expect(list.briefs).toHaveLength(1);
  });

  it("answers 503 until the store is ready, and 502 in the host's words when the memory read fails", async () => {
    const wire = new FakeWire();
    const store = new CrewStore({ wire, now: () => NOW });
    expect((await handle("/brief", "POST", undefined, { store, memory: fakeMemory() })).status).toBe(503);
    await store.open();
    const refusing = fakeMemory();
    refusing.search = async () => {
      throw new Error("MemoryPoppy is paused — resume it on its card");
    };
    const r = await handle("/brief", "POST", undefined, { store, memory: refusing, now: () => NOW });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: "memory_read_failed", message: "MemoryPoppy is paused — resume it on its card" });
  });

  it("describes a read in words", () => {
    expect(describeRead({ id: "b", at: NOW, purpose: PURPOSE, text: "", memoryIds: [], receipts: [], read: { events: 2, people: 3, bytes: 1230 } })).toBe("Read 2 meetings and 3 people for “Morning briefing” — 1.2 KB.");
    expect(describeRead({ id: "b", at: NOW, purpose: PURPOSE, text: "", memoryIds: [], receipts: [], read: { events: 0, people: 0, bytes: 0 } })).toMatch(/^Read nothing for/);
  });
});
