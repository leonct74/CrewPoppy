// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { AgentDef } from "./agents";
import { PACK_FORMAT, type PackStore, applyPack, buildPack, describePackReport, readPack } from "./pack";
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

const emma: AgentDef = { id: "emma", name: "Emma", role: "Thank-you writer", instructions: "Write warm notes.", tier: "auto", memory: true, capUsd: 2, tools: ["note_read", "note_write"], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };

describe("the Crew Pack", () => {
  it("bundles the agents, their notes and their files — and nothing that is a credential or a receipt", async () => {
    const store = new FakePackStore();
    await store.saveAgent(emma);
    await store.saveNote({ agent: "emma", key: "tone", value: "warm", updatedAt: NOW });
    await store.saveFile({ agent: "emma", path: "drafts/a.txt", content: "Dear all", updatedAt: NOW });
    const pack = await buildPack(store, NOW, "com.crewpoppy.cloud.google");
    expect(pack).toEqual({ format: PACK_FORMAT, version: 1, exportedAt: NOW, edition: "google", poppy: "com.crewpoppy.cloud.google", agents: [emma], notes: [{ agent: "emma", key: "tone", value: "warm", updatedAt: NOW }], files: [{ agent: "emma", path: "drafts/a.txt", content: "Dear all", updatedAt: NOW }] });
    expect(JSON.stringify(pack)).not.toMatch(/token|receipt|secret/i);
  });

  it("reads a pack with care: the format, the version, the size", () => {
    expect(readPack("nope")).toEqual({ error: "That is not a Crew Pack — expected a JSON object." });
    expect(readPack({ format: "csv" })).toEqual({ error: 'That is not a Crew Pack — its format is "csv".' });
    expect(readPack({ format: PACK_FORMAT, version: 9 })).toMatchObject({ error: expect.stringContaining("version 9") });
    expect(readPack({ format: PACK_FORMAT, version: 1, agents: Array.from({ length: 101 }, () => ({})) })).toMatchObject({ error: expect.stringContaining("101 agents") });
    expect(readPack({ format: PACK_FORMAT, version: 1 })).toEqual({ pack: { format: PACK_FORMAT, version: 1, exportedAt: "", edition: "google", poppy: "", agents: [], notes: [], files: [] } });
  });

  it("brings a pack in as if typed into the form: valid agents added or updated, the crew's own names refused, notes and files only for kept agents and only under names the tools would accept", async () => {
    const store = new FakePackStore();
    await store.saveAgent(emma);
    const read = readPack({
      format: PACK_FORMAT,
      version: 1,
      agents: [
        { id: "emma", name: "Emma", role: "Editor", instructions: "Edit.", tier: "deep", capUsd: 4, tools: ["file_append", "send_email"] },
        { id: "bo", name: "Bo", role: "Poet", instructions: "Write a haiku.", memory: false, schedule: { every: "day", at: "09:00" } },
        { id: "assistant", name: "Assistant", role: "r", instructions: "i" },
        { name: "", role: "r", instructions: "i" },
      ],
      notes: [
        { agent: "bo", key: "style", value: "short", updatedAt: NOW },
        { agent: "bo", key: "../emma", value: "x" },
        { agent: "ghost", key: "k", value: "v" },
      ],
      files: [
        { agent: "bo", path: "haiku/first.txt", content: "old pond", updatedAt: NOW },
        { agent: "bo", path: "../emma/notes.txt", content: "steal" },
      ],
    });
    expect("pack" in read).toBe(true);
    const report = await applyPack(store, (read as { pack: never }).pack, NOW, new Set(["assistant", "briefer"]), "Europe/Rome");
    expect(report).toEqual({
      agents: { added: 1, updated: 0 },
      notes: 1,
      files: 1,
      skipped: ['Emma: no tool is called "send_email" — the catalogue is fixed', 'Assistant: "assistant" is one of the crew\'s own names', "(unnamed): give the agent a name — a given name, like a teammate", 'a note of bo ("../emma") — not a note the tools would keep', 'a file of bo ("../emma/notes.txt") — not a file the tools would keep'],
    });
    // Emma was refused (a bad tool), so she is unchanged; Bo arrived with his schedule on the owner's clock.
    expect(store.agentMap.get("emma")).toEqual(emma);
    expect(store.agentMap.get("bo")).toMatchObject({ id: "bo", role: "Poet", memory: false, schedule: { every: "day", at: "09:00", timeZone: "Europe/Rome" }, createdAt: NOW });
    expect(store.noteList).toEqual([{ agent: "bo", key: "style", value: "short", updatedAt: NOW }]);
    expect(store.fileList).toEqual([{ agent: "bo", path: "haiku/first.txt", content: "old pond", updatedAt: NOW }]);
    expect(describePackReport(report)).toBe("1 agent (1 new, 0 updated), 1 note, 1 file brought in; 5 left out.");
    // A second import of a good Emma updates her and keeps her birth date.
    const again = await applyPack(store, { format: PACK_FORMAT, version: 1, exportedAt: NOW, edition: "google", poppy: "", agents: [{ ...emma, role: "Editor" }], notes: [], files: [] }, "2026-09-09T00:00:00.000Z", new Set(), "UTC");
    expect(again.agents).toEqual({ added: 0, updated: 1 });
    expect(store.agentMap.get("emma")).toMatchObject({ role: "Editor", createdAt: emma.createdAt, updatedAt: "2026-09-09T00:00:00.000Z" });
  });
});
