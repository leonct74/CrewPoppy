// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { AgentDef } from "./agents";
import { PACK_FORMAT, type PackStore, applyPack, buildPack, describePackReport, fromPackSchedule, readPack, toPackSchedule } from "./pack";
import type { FileRecord, NoteRecord } from "./store";

const NOW = "2026-09-08T10:00:00.000Z";

class FakePackStore implements PackStore {
  readonly agentMap = new Map<string, AgentDef>();
  readonly noteList: NoteRecord[] = [];
  readonly fileList: FileRecord[] = [];
  async agents() {
    return [...this.agentMap.values()];
  }
  async agent(id: string) {
    return this.agentMap.get(id) ?? null;
  }
  async saveAgent(a: AgentDef) {
    this.agentMap.set(a.id, a);
  }
  async notes(agentId?: string) {
    return this.noteList.filter((n) => !agentId || n.agent === agentId);
  }
  async saveNote(n: NoteRecord) {
    this.noteList.push(n);
  }
  async files(agentId?: string) {
    return this.fileList.filter((f) => !agentId || f.agent === agentId);
  }
  async saveFile(f: FileRecord) {
    this.fileList.push(f);
  }
}

const emma: AgentDef = { id: "emma", name: "Emma", role: "Thank-you writer", instructions: "Write warm notes.", tier: "auto", memory: true, capUsd: 2, tools: ["note_read", "note_write"], schedule: { every: "day", at: "15:30", timeZone: "Europe/Rome", task: "Thank today's people." }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };

describe("the Crew Pack — the shared format, this edition's edge", () => {
  it("bundles the agents in the live app's terms, their notes and their files — and nothing that is a credential or a receipt", async () => {
    const store = new FakePackStore();
    await store.saveAgent(emma);
    await store.saveNote({ agent: "emma", key: "tone", value: "warm", updatedAt: NOW });
    await store.saveFile({ agent: "emma", path: "drafts/a.txt", content: "Dear all", updatedAt: NOW });
    const pack = await buildPack(store, NOW, "com.crewpoppy.cloud.google");
    expect(pack).toEqual({
      format: PACK_FORMAT,
      version: 2,
      exportedAt: NOW,
      edition: "google",
      poppy: "com.crewpoppy.cloud.google",
      agents: [{ id: "emma", name: "Emma", role: "Thank-you writer", instructions: "Write warm notes.", tools: ["memory_read", "memory_write"], capUsd: 2, model: "auto", memory: true, schedule: { kind: "daily", hour: 15, minute: 30, weekday: 1, timezone: "Europe/Rome", task: "Thank today's people.", enabled: true }, createdAt: emma.createdAt, updatedAt: emma.updatedAt }],
      notes: [{ agent: "emma", key: "tone", value: "warm", updatedAt: NOW }],
      files: [{ agent: "emma", path: "drafts/a.txt", content: "Dear all", updatedAt: NOW }],
    });
    expect(JSON.stringify(pack)).not.toMatch(/token|receipt|secret/i);
  });

  it("writes a schedule in the live app's shape and reads it back on the owner's clock", () => {
    expect(toPackSchedule({ every: "hour", at: "00:00", timeZone: "UTC" })).toEqual({ kind: "hourly", hour: 0, minute: 0, weekday: 1, timezone: "UTC", task: "", enabled: true });
    expect(toPackSchedule({ every: "week", at: "09:05", weekday: 5, timeZone: "Europe/Rome" })).toEqual({ kind: "weekly", hour: 9, minute: 5, weekday: 5, timezone: "Europe/Rome", task: "", enabled: true });
    expect(fromPackSchedule({ kind: "weekly", hour: 9, minute: 5, weekday: 5, timezone: "", task: "The week.", enabled: true }, "Europe/Rome")).toEqual({ every: "week", at: "09:05", weekday: 5, timeZone: "Europe/Rome", task: "The week." });
    expect(fromPackSchedule({ kind: "hourly", hour: 3, minute: 3, weekday: 0, timezone: "Asia/Tokyo", task: "", enabled: true }, "UTC")).toEqual({ every: "hour", at: "00:00", timeZone: "Asia/Tokyo" });
    expect(fromPackSchedule({ kind: "daily", hour: 9, minute: 0, weekday: 1, timezone: "UTC", task: "x", enabled: false }, "UTC")).toBeNull();
    expect(fromPackSchedule(undefined, "UTC")).toBeNull();
  });

  it("reads a pack with care, and a version-1 pack of this edition as the shared one", () => {
    expect(readPack("nope")).toEqual({ error: "That is not a Crew Pack — expected a JSON object." });
    expect(readPack({ format: "csv" })).toEqual({ error: 'That is not a Crew Pack — its format is "csv".' });
    expect(readPack({ format: PACK_FORMAT, version: 9 })).toMatchObject({ error: expect.stringContaining("version 9") });
    expect(readPack({ format: PACK_FORMAT, version: 2, agents: Array.from({ length: 101 }, () => ({})) })).toMatchObject({ error: expect.stringContaining("101 agents") });
    expect(readPack({ format: PACK_FORMAT, version: 2, edition: "google" })).toEqual({ pack: { format: PACK_FORMAT, version: 2, exportedAt: "", edition: "google", poppy: "", agents: [], notes: [], files: [] } });
    const legacy = readPack({ format: PACK_FORMAT, version: 1, edition: "google", poppy: "com.crewpoppy.cloud.google", exportedAt: NOW, agents: [emma], notes: [], files: [] });
    expect(legacy).toEqual({ pack: { format: PACK_FORMAT, version: 2, exportedAt: NOW, edition: "google", poppy: "com.crewpoppy.cloud.google", agents: [{ id: "emma", name: "Emma", role: "Thank-you writer", instructions: "Write warm notes.", tools: ["memory_read", "memory_write"], capUsd: 2, model: "auto", memory: true, schedule: { kind: "daily", hour: 15, minute: 30, weekday: 1, timezone: "Europe/Rome", task: "Thank today's people.", enabled: true } }], notes: [], files: [] } });
  });

  it("brings a pack in as if typed into the form: agents added or updated with the abilities not on Google yet said, the crew's own names refused, notes and files only for kept agents and only under names the tools would accept", async () => {
    const store = new FakePackStore();
    await store.saveAgent(emma);
    const read = readPack({
      format: PACK_FORMAT,
      version: 2,
      edition: "aws",
      agents: [
        { id: "emma", name: "Emma", role: "Editor", instructions: "Edit.", model: "deep", capUsd: 4, tools: ["workspace_append", "send_email", "save_pdf"] },
        { id: "bo", name: "Bo", role: "Poet", instructions: "Write a haiku.", memory: false, tools: [], capUsd: 3, schedule: { kind: "daily", hour: 9, minute: 0, weekday: 1, timezone: "", task: "", enabled: true } },
        { id: "zed", name: "Zed", role: "r", instructions: "i", tools: ["teleport"], capUsd: 1 },
        { id: "assistant", name: "Assistant", role: "r", instructions: "i", tools: [], capUsd: 1 },
        { name: "", role: "r", instructions: "i", tools: [], capUsd: 1 },
      ],
      notes: [
        { agent: "bo", key: "style", value: "short", updatedAt: NOW },
        { agent: "bo", key: "../emma", value: "x" },
        { agent: "ghost", key: "k", value: "v" },
      ],
      files: [
        { agent: "bo", path: "haiku/first.txt", content: "old pond", updatedAt: NOW },
        { agent: "bo", path: "../emma/notes.txt", content: "steal" },
        { agent: "bo", path: "report.pdf", content: "JVBERi0=", encoding: "base64" },
      ],
    });
    expect("pack" in read).toBe(true);
    const report = await applyPack(store, (read as { pack: never }).pack, NOW, new Set(["assistant", "briefer"]), "Europe/Rome");
    expect(report).toEqual({
      agents: { added: 1, updated: 1 },
      notes: 1,
      files: 1,
      skipped: [
        "Emma's e-mail to others, PDFs — not on Google yet",
        'Zed: no tool is called "teleport" — the catalogue is fixed',
        'Assistant: "assistant" is one of the crew\'s own names',
        "(unnamed): give the agent a name — a given name, like a teammate",
        'a note of bo ("../emma") — not a note the tools would keep',
        'a file of bo ("../emma/notes.txt") — not a file the tools would keep',
        'a file of bo ("report.pdf") — a binary file, which this edition does not keep',
      ],
    });
    // Emma came back from the AWS edition: her schedule there is gone (the pack had none), her tools mapped, her tier the pack's class.
    expect(store.agentMap.get("emma")).toMatchObject({ id: "emma", role: "Editor", tier: "deep", capUsd: 4, tools: ["file_append"], createdAt: emma.createdAt, updatedAt: NOW });
    expect(store.agentMap.get("emma")!.schedule).toBeUndefined();
    // Bo arrived with his schedule on the owner's clock and no task — he runs on his brief.
    expect(store.agentMap.get("bo")).toMatchObject({ id: "bo", role: "Poet", memory: false, tools: [], schedule: { every: "day", at: "09:00", timeZone: "Europe/Rome" }, createdAt: NOW });
    expect(store.noteList).toEqual([{ agent: "bo", key: "style", value: "short", updatedAt: NOW }]);
    expect(store.fileList).toEqual([{ agent: "bo", path: "haiku/first.txt", content: "old pond", updatedAt: NOW }]);
    expect(describePackReport(report)).toBe("2 agents (1 new, 1 updated), 1 note, 1 file brought in; 7 left out.");
    // A round trip: what this edition writes, it reads back unchanged.
    const out = await buildPack(store, NOW, "com.crewpoppy.cloud.google");
    const again = await applyPack(new FakePackStore(), out, "2026-09-09T00:00:00.000Z", new Set(), "UTC");
    expect(again).toEqual({ agents: { added: 2, updated: 0 }, notes: 1, files: 1, skipped: [] });
  });
});
