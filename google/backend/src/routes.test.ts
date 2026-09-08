// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { Memory, MemoryPage } from "@agentspoppy/core";
import type { FirestoreWire, IndexField, WireDoc, WireWrite } from "./firestore";
import { type MemoryReader, handle } from "./routes";
import { CrewStore } from "./store";
import type { Model } from "./vertex";
import { responsesOf, scriptedModel } from "./testing";

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
  async delete(c: string, id: string): Promise<void> {
    this.col(c).delete(id);
  }
}

const NOW = "2026-09-08T06:30:00.000Z";
type RunRecordLike = { id: string; status?: string; answer: string; question?: { question: string; draft?: string }; conversation?: string; steps?: Array<{ kind: string; text: string }>; toolsUsed?: string[]; iterations?: number; answeredAt?: string; tier: string; why: string; judge?: unknown; model?: { name: string; promptTokens: number; outputTokens: number; ceilingUsd: number } };
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

type Asked = { system: string; user: string; model?: string; max: number; tools: string[] };
/** A model that answers in words — the Briefer's pen and the crew's conversation alike — every call recorded. */
function fakeModel(reply: (asked: Asked) => { text: string; promptTokens: number; outputTokens: number } | Error): Model & { asked: Asked[] } {
  const asked: Asked[] = [];
  const answer = (a: Asked) => {
    const r = reply(a);
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    asked,
    name: "gemini-2.5-flash",
    words: "Gemini 2.5 Flash on Vertex AI",
    async generate(system, user, max, m) {
      const a: Asked = { system, user, model: m, max, tools: [] };
      asked.push(a);
      return { ...answer(a), model: m ?? "gemini-2.5-flash" };
    },
    async converse(req) {
      const last = req.contents[req.contents.length - 1] as { parts: Array<{ text?: string }> };
      const a: Asked = { system: req.system, user: last.parts.map((p) => p.text ?? "").join(""), model: req.model, max: req.maxOutputTokens, tools: req.tools.map((t) => t.name) };
      asked.push(a);
      const r = answer(a);
      return { text: r.text, calls: [], parts: [{ text: r.text }], promptTokens: r.promptTokens, outputTokens: r.outputTokens, model: req.model ?? "gemini-2.5-flash", truncated: false };
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
    expect(r.body).toMatchObject({ ok: true, cloud: { state: "ready", region: "eur3" }, memory: { available: true, reads: ["person", "event"] }, runs: [], waiting: [] });
    expect(r.body).not.toHaveProperty("crew");
  });

  it("answers 503 until the store is ready", async () => {
    const wire = new FakeWire();
    const store = new CrewStore({ wire, now: () => NOW });
    expect((await handle("/agents", "GET", undefined, { store, memory: fakeMemory() })).status).toBe(503);
    await store.open();
    expect((await handle("/agents", "GET", undefined, { store, memory: fakeMemory() })).status).toBe(200);
  });

  it("agents: the user defines one, runs it as itself under its own cap, and deletes it", async () => {
    const { store, wire } = await ready();
    const memory = fakeMemory();
    const model = fakeModel(() => ({ text: "Dear all, thank you for Cozy Code.", promptTokens: 500, outputTokens: 60 }));
    const asked = model.asked;
    const bad = await handle("/agents", "POST", { name: "", role: "x", instructions: "" }, { store, memory, model });
    expect(bad.status).toBe(400);
    expect((bad.body as { problems: string[] }).problems).toHaveLength(2);
    const created = (await handle("/agents", "POST", { name: "Emma", role: "Thank-you writer", instructions: "Write warm thank-you notes to the people I meet.", tier: "auto", memory: true, capUsd: 2 }, { store, memory, model, now: () => NOW })).body as { agent: { id: string; tier: string } };
    expect(created.agent).toMatchObject({ id: "emma", tier: "auto", capUsd: 2 });
    expect(wire.col("agents").get("emma")).toMatchObject({ name: "Emma" });
    const list = (await handle("/agents", "GET", undefined, { store, memory, model, now: () => NOW })).body as { agents: Array<{ id: string; monthUsd: number }>; };
    expect(list.agents).toEqual([expect.objectContaining({ id: "emma", monthUsd: 0 })]);
    const run = (await handle("/agents/emma/run", "POST", { request: "Thank the people I met at the board meeting this week." }, { store, memory, model, now: () => NOW, timeZone: () => "Europe/Rome", newId: () => "run-1" })).body as { ok: boolean; run: { agent: string; tier: string; read: { count: number; purpose: string }; model: { name: string } }; agent: { monthUsd: number } };
    expect(run.ok).toBe(true);
    expect(run.run).toMatchObject({ agent: "emma", tier: "standard", read: { count: 1, purpose: 'Emma: "Thank the people I met at the board meeting this week."' } });
    expect(asked[0]!.system).toMatch(/^You are Emma, Thank-you writer/);
    expect(asked[0]!.user).toContain("[event] Board meeting");
    expect(memory.calls.at(-1)).toMatchObject({ path: "search", req: { purpose: 'Emma: "Thank the people I met at the board meeting this week."', model: "Gemini 2.5 Flash on Vertex AI" } });
    expect(run.agent.monthUsd).toBeCloseTo((560 / 1_000_000) * 10, 8);
    expect((wire.col("spend").get("2026-09") as { agents: Record<string, number> }).agents.emma).toBeCloseTo((560 / 1_000_000) * 10, 8);
    // Its own cap: a $2 agent that already spent $2 does not run.
    wire.col("spend").set("2026-09", { ...(wire.col("spend").get("2026-09") as object), agents: { emma: 2 } });
    const capped = (await handle("/agents/emma/run", "POST", {}, { store, memory, model, now: () => NOW })).body as { ok: boolean; message: string };
    expect(capped.ok).toBe(false);
    expect(capped.message).toMatch(/Emma did not run: its monthly limit of \$2\.00/);
    expect((await handle("/agents/emma/delete", "POST", {}, { store, memory, model })).status).toBe(200);
    expect(wire.col("agents").has("emma")).toBe(false);
    expect((await handle("/agents/emma/run", "POST", {}, { store, memory, model })).status).toBe(404);
  });

  it("agents: an unknown tier is refused, and an agent's own tier overrides the rules", async () => {
    const { store } = await ready();
    const memory = fakeMemory();
    const model = fakeModel(() => ({ text: "ok", promptTokens: 10, outputTokens: 5 }));
    const asked = model.asked;
    expect((await handle("/agents", "POST", { name: "Bo", role: "r", instructions: "i", tier: "huge" }, { store, memory, model })).status).toBe(400);
    await handle("/agents", "POST", { name: "Bo", role: "Poet", instructions: "Write a haiku about the day.", tier: "deep", memory: false }, { store, memory, model, now: () => NOW });
    const r = (await handle("/agents/bo/run", "POST", {}, { store, memory, model, now: () => NOW })).body as { run: { tier: string; why: string; request: string; read: { purpose: string } } };
    expect(r.run).toMatchObject({ tier: "deep", why: "Bo's own setting", request: "(Bo's brief)", read: { purpose: "" } });
    expect(asked.map((a) => a.model)).toEqual(["gemini-2.5-pro"]);
  });
  it("a run that asks you pauses under Today and resumes with your answer where the agent asked; the agent is busy until then", async () => {
    const { store, wire } = await ready();
    const memory = fakeMemory();
    const model = scriptedModel([{ text: "One question first.", calls: [{ name: "ask_user", args: { question: "Sign it Marco?", draft: "Dear all, thank you." } }] }, { text: "Dear all, thank you. Marco" }]);
    await handle("/agents", "POST", { name: "Emma", role: "Thank-you writer", instructions: "Write thank-you notes; ask before signing.", tier: "light", memory: false }, { store, memory, model, now: () => NOW });
    const paused = (await handle("/agents/emma/run", "POST", { request: "Thank the board." }, { store, memory, model, now: () => NOW, newId: () => "run-w" })).body as { ok: boolean; run: RunRecordLike };
    expect(paused.ok).toBe(true);
    expect(paused.run).toMatchObject({ id: "run-w", status: "waiting", question: { question: "Sign it Marco?", draft: "Dear all, thank you." }, answer: "One question first.", toolsUsed: ["ask_user"] });
    expect(paused.run.conversation).toBeUndefined();
    expect(typeof (wire.col("runs").get("run-w") as { conversation?: string }).conversation).toBe("string");
    const state = (await handle("/state", "GET", undefined, { store, memory, model, now: () => NOW })).body as { waiting: RunRecordLike[] };
    expect(state.waiting.map((r) => r.id)).toEqual(["run-w"]);
    expect((await handle("/agents/emma/run", "POST", {}, { store, memory, model, now: () => NOW })).status).toBe(409);
    expect((await handle("/runs/run-w/answer", "POST", { answer: "" }, { store, memory, model })).status).toBe(400);
    const resumed = (await handle("/runs/run-w/answer", "POST", { answer: "Yes, sign it Marco." }, { store, memory, model, now: () => "2026-09-08T06:35:00.000Z" })).body as { ok: boolean; run: RunRecordLike };
    expect(resumed.ok).toBe(true);
    expect(resumed.run).toMatchObject({ id: "run-w", status: "succeeded", answer: "Dear all, thank you. Marco", answeredAt: "2026-09-08T06:35:00.000Z", iterations: 2 });
    expect(resumed.run.question).toBeUndefined();
    expect((wire.col("runs").get("run-w") as { conversation?: string }).conversation).toBeUndefined();
    expect(resumed.run.steps!.map((s) => s.kind)).toEqual(["model", "tool", "asked", "result", "model"]);
    expect(resumed.run.steps![3]!.text).toBe("You answered: Yes, sign it Marco.");
    expect(responsesOf(model.requests[1]!)).toEqual([{ name: "ask_user", response: { result: "The user answered: Yes, sign it Marco." } }]);
    expect(model.requests[1]!.model).toBe("gemini-2.5-flash-lite");
    expect(wire.col("spend").get("2026-09")).toMatchObject({ calls: 2 });
    expect((await handle("/runs/run-w/answer", "POST", { answer: "again" }, { store, memory, model })).status).toBe(409);
    expect((await handle("/runs/nope/stop", "POST", {}, { store, memory, model })).status).toBe(404);
  });

  it("an agent's tools are its own: a note kept in one run is read in the next, the transcript shows every step, and Remove takes the notes along", async () => {
    const { store, wire } = await ready();
    const memory = fakeMemory();
    const model = scriptedModel([{ calls: [{ name: "note_write", args: { key: "tone", value: "warm and short" } }] }, { text: "Noted for next time." }, { calls: [{ name: "note_read", args: { key: "tone" } }] }, { text: "Warm and short it is." }]);
    await handle("/agents", "POST", { name: "Emma", role: "Writer", instructions: "Keep the tone the user likes.", tier: "light", memory: false }, { store, memory, model, now: () => NOW });
    const one = (await handle("/agents/emma/run", "POST", { request: "Remember: warm and short." }, { store, memory, model, now: () => NOW, newId: () => "run-1" })).body as { run: RunRecordLike };
    expect(one.run).toMatchObject({ status: "succeeded", answer: "Noted for next time.", toolsUsed: ["note_write"], iterations: 2 });
    expect(wire.col("notes").get("emma~tone")).toMatchObject({ agent: "emma", key: "tone", value: "warm and short" });
    const two = (await handle("/agents/emma/run", "POST", { request: "Write the note." }, { store, memory, model, now: () => NOW, newId: () => "run-2" })).body as { run: RunRecordLike; planLine: string };
    expect(two.run.steps!.map((s) => `${s.kind}: ${s.text}`)).toEqual(["tool: note_read key=tone", "result: warm and short", "model: Warm and short it is."]);
    expect(two.planLine).toMatch(/^Gemini 2\.5 Flash-Lite on Vertex AI — Emma's own setting · 240 tokens \(\d+ in, \d+ out\) ≈ \$0\.000\d at Google's price\.$/);
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(["note_read", "note_write", "file_list", "file_read", "file_write", "file_append", "ask_user"]);
    await handle("/agents/emma/delete", "POST", {}, { store, memory, model });
    expect(wire.col("notes").size).toBe(0);
  });

  it("the judge: when no rule places a request, the small model's one word picks the tier at the light rate, and the answer says so", async () => {
    const { store, wire } = await ready();
    const memory = fakeMemory();
    const model = scriptedModel([{ text: "Welcome, everyone.", promptTokens: 400, outputTokens: 100 }], "DEEP");
    await handle("/agents", "POST", { name: "Gus", role: "Writer", instructions: "Write what is asked.", tier: "auto", memory: false }, { store, memory, model, now: () => NOW });
    const request = "Could you put together a friendly welcome message for the new members joining the neighbourhood gardening group this autumn, mentioning the tool library, the weekend sessions and the shared compost heap, in a warm tone?";
    const r = (await handle("/agents/gus/run", "POST", { request }, { store, memory, model, now: () => NOW, timeZone: () => "Europe/Rome", newId: () => "r-j" })).body as { run: RunRecordLike; planLine: string };
    expect(r.run).toMatchObject({ tier: "deep", why: "the small model judged it a task that needs reasoning", judge: { tier: "deep", promptTokens: 20, outputTokens: 2 }, answer: "Welcome, everyone." });
    expect(model.generated[0]!.model).toBe("gemini-2.5-flash-lite");
    expect(model.requests[0]!.model).toBe("gemini-2.5-pro");
    expect(r.run.model).toMatchObject({ name: "gemini-2.5-pro", promptTokens: 420, outputTokens: 102 });
    expect(r.run.model!.ceilingUsd).toBeCloseTo((22 / 1_000_000) * 5 + (500 / 1_000_000) * 40, 10);
    expect(r.planLine).toBe("Gemini 2.5 Pro on Vertex AI — the small model judged it a task that needs reasoning · 522 tokens (420 in, 102 out) ≈ $0.0015 at Google's price.");
    expect(wire.col("spend").get("2026-09")).toMatchObject({ calls: 2 });
    // A rule that fires leaves the judge out of it.
    const light = scriptedModel([{ text: "Sure." }], "DEEP");
    await handle("/agents/gus/run", "POST", { request: "Rewrite this more politely: send me the report." }, { store, memory, model: light, now: () => NOW });
    expect(light.generated).toHaveLength(0);
  });

  it("the Crew Pack leaves as one file — through a one-shot download — and comes back as agents, notes and files", async () => {
    const { store, wire } = await ready();
    const memory = fakeMemory();
    const model = scriptedModel([]);
    await handle("/agents", "POST", { name: "Emma", role: "Writer", instructions: "Write.", memory: false }, { store, memory, model, now: () => NOW });
    await store.saveNote({ agent: "emma", key: "tone", value: "warm", updatedAt: NOW });
    const pack = (await handle("/crew-pack", "GET", undefined, { store, memory, model, now: () => NOW })).body as { format: string; agents: Array<{ id: string }>; notes: unknown[] };
    expect(pack.format).toBe("crewpoppy-crew-pack");
    expect(pack.agents.map((a) => a.id)).toEqual(["emma"]);
    expect(pack.notes).toHaveLength(1);
    const token = (await handle("/export-token", "POST", undefined, { store, memory, model })).body as { path: string; filename: string };
    expect(token.filename).toBe("crewpoppy-crew-pack.json");
    const dl = await handle(token.path, "GET", undefined, { store, memory, model, now: () => NOW });
    expect(dl.contentType).toBe("application/json; charset=utf-8");
    expect(dl.filename).toBe("crewpoppy-crew-pack.json");
    expect((JSON.parse(dl.body as string) as { agents: unknown[] }).agents).toHaveLength(1);
    expect((await handle(token.path, "GET", undefined, { store, memory, model })).status).toBe(404);
    const imported = (await handle("/crew-pack", "POST", { pack: { format: "crewpoppy-crew-pack", version: 1, agents: [{ id: "bo", name: "Bo", role: "Poet", instructions: "Haiku." }], notes: [{ agent: "bo", key: "k", value: "v" }], files: [{ agent: "bo", path: "../x", content: "c" }] } }, { store, memory, model, now: () => NOW, timeZone: () => "Europe/Rome" })).body as { line: string; report: { skipped: string[] } };
    expect(imported.line).toBe("1 agent (1 new, 0 updated), 1 note, 0 files brought in; 1 left out.");
    expect(wire.col("agents").has("bo")).toBe(true);
    expect((await handle("/crew-pack", "POST", { format: "csv" }, { store, memory, model })).status).toBe(400);
  });

  it("/opened tells what the cloud job did since the last open — cloud runs only, each shown once", async () => {
    const { store, wire } = await ready();
    const memory = fakeMemory();
    const base = { agent: "nico", agentName: "Nico", request: "(Nico's brief)", tier: "light" as const, why: "w", choice: "auto" as const, read: { count: 0, bytes: 0, receipts: [], purpose: "" }, status: "succeeded" as const, trigger: "schedule" as const };
    await store.saveRun({ ...base, id: "c1", at: "2026-09-08T05:00:00.000Z", via: "cloud", answer: "Done in the cloud." });
    await store.saveRun({ ...base, id: "a1", at: "2026-09-08T05:30:00.000Z", via: "app", answer: "Done at home." });
    const first = (await handle("/opened", "POST", undefined, { store, memory, now: () => NOW })).body as { away: Array<{ id: string }>; since: string };
    expect(first.since).toBe("");
    expect(first.away.map((r) => r.id)).toEqual(["c1"]);
    expect(wire.col("meta").get("lastOpen")).toEqual({ at: NOW });
    await store.saveRun({ ...base, id: "c2", at: "2026-09-08T06:45:00.000Z", via: "cloud", answer: "Later." });
    const second = (await handle("/opened", "POST", undefined, { store, memory, now: () => "2026-09-08T07:00:00.000Z" })).body as { away: Array<{ id: string }> };
    expect(second.away.map((r) => r.id)).toEqual(["c2"]);
  });

  it("an agent with tools whose small model garbles its calls twice gets the standard model for the run — and the run says so", async () => {
    const { store } = await ready();
    const memory = fakeMemory();
    const model = scriptedModel([{ text: "Done properly." }]);
    let first = true;
    const flaky = model.converse.bind(model);
    model.converse = async (req) => {
      if (first) {
        first = false;
        throw new Error("Gemini 2.5 Flash-Lite on Vertex AI garbled a tool call twice (MALFORMED_FUNCTION_CALL) — try again, or pick the standard model for this job.");
      }
      return flaky(req);
    };
    await handle("/agents", "POST", { name: "Nico", role: "Note writer", instructions: "Write a note.", tier: "light", memory: false }, { store, memory, model, now: () => NOW });
    const r = (await handle("/agents/nico/run", "POST", {}, { store, memory, model, now: () => NOW, newId: () => "run-esc" })).body as { ok: boolean; run: RunRecordLike };
    expect(r.ok).toBe(true);
    expect(r.run).toMatchObject({ status: "succeeded", tier: "standard", answer: "Done properly." });
    expect(r.run.why).toBe("Nico's own setting; the small model garbled its tool calls, so Gemini 2.5 Flash on Vertex AI did this run");
    expect(model.requests[0]!.model).toBe("gemini-2.5-flash");
    expect(r.run.model!.name).toBe("gemini-2.5-flash");
  });

  it("cloud/slots: each scheduled agent as the cron string the host's alarm takes, in the owner's zone — none for an agent without a schedule", async () => {
    const { store } = await ready();
    const memory = fakeMemory();
    await handle("/agents", "POST", { name: "Emma", role: "Thank-you writer", instructions: "Write warm thank-you notes.", schedule: { every: "day", at: "15:30", task: "Thank the people I met today." } }, { store, memory, now: () => NOW, timeZone: () => "Europe/Rome" });
    await handle("/agents", "POST", { name: "Nico", role: "Note keeper", instructions: "Keep notes." }, { store, memory, now: () => NOW, timeZone: () => "Europe/Rome" });
    const r = (await handle("/cloud/slots", "GET", undefined, { store, memory, now: () => NOW })).body as { slots: unknown[] };
    expect(r.slots).toEqual([{ agent: "emma", name: "Emma", cron: "30 15 * * *", timeZone: "Europe/Rome", line: "every day at 15:30 (Europe/Rome)", nextRunAt: expect.stringMatching(/T13:30:00\.000Z$/), task: "Thank the people I met today." }]);
  });

  it("templates: the live app's recipes offered with what is not on Google yet; activating adds the agent and its files; a recipe this edition cannot serve is refused in words", async () => {
    const { store } = await ready();
    const memory = fakeMemory();
    const list = (await handle("/templates", "GET", undefined, { store, memory, timeZone: () => "Europe/Rome" })).body as { templates: Array<{ key: string; name: string; notYet: string[]; unavailable?: string; files: string[]; scheduleLine: string }> };
    expect(list.templates.map((t) => t.key)).toEqual(["offer-writer", "document-answerer", "expense-tracker", "trip-splitter", "morning-brief", "morning-brief-memory"]);
    expect(list.templates.find((t) => t.key === "expense-tracker")).toMatchObject({ name: "Penny", notYet: ["reading photos", "PDFs", "e-mail to you"], files: ["categories.md"], scheduleLine: "" });
    expect(list.templates.find((t) => t.key === "morning-brief")).toMatchObject({ unavailable: "it reads web pages and e-mails you the brief", scheduleLine: "every day at 07:30 (Europe/Rome)" });
    const made = (await handle("/templates/expense-tracker/activate", "POST", undefined, { store, memory, now: () => NOW, timeZone: () => "Europe/Rome" })).body as { agent: { id: string; tools: string[]; memory: boolean }; files: string[] };
    expect(made.agent).toMatchObject({ id: "penny", memory: false, tools: ["note_read", "note_write", "file_list", "file_read", "file_write", "file_append", "ask_user"] });
    expect(made.files).toEqual(["categories.md"]);
    expect((await store.files("penny")).map((f) => f.path)).toEqual(["categories.md"]);
    expect((await store.agent("penny"))?.name).toBe("Penny");
    const refused = await handle("/templates/offer-writer/activate", "POST", undefined, { store, memory, now: () => NOW });
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe("Max is coming to this edition — its offers are PDFs sent by e-mail, which it cannot do yet.");
    expect((await handle("/templates/nobody/activate", "POST", undefined, { store, memory })).status).toBe(404);
  });

  it("templates: the catalogue answers while the project is still being set up — the store's routes wait, this one does not", async () => {
    const wire = new FakeWire();
    const store = new CrewStore({ wire, now: () => NOW });
    const memory = fakeMemory();
    expect((await handle("/agents", "GET", undefined, { store, memory })).status).toBe(503);
    const r = await handle("/templates", "GET", undefined, { store, memory, timeZone: () => "Europe/Rome" });
    expect(r.status).toBe(200);
    expect((r.body as { templates: Array<{ key: string }> }).templates.map((t) => t.key)).toEqual(["offer-writer", "document-answerer", "expense-tracker", "trip-splitter", "morning-brief", "morning-brief-memory"]);
  });
});
