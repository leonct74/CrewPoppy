// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import { RECIPES } from "../../../shared/src/recipes";
import { TEMPLATES, activateTemplate, scheduleOf, templateByKey } from "./templates";

const NOW = "2026-09-08T16:00:00.000Z";

describe("the live app's recipes, offered here", () => {
  it("offers every recipe of the shared catalogue, its tools mapped to this edition's, the missing abilities named — and never the user's memory by default", () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual([...RECIPES.map((r) => r.key), "morning-brief-memory"]);
    expect(templateByKey("morning-brief-memory")).toMatchObject({ name: "Bea", memory: true, tools: [], schedule: { every: "day", at: "07:30" }, notYet: [] });
    const nora = templateByKey("document-answerer")!;
    expect(nora).toMatchObject({ name: "Nora", tools: ["note_read", "note_write", "file_list", "file_read"], memory: false, capUsd: 5, notYet: [], files: [] });
    expect(nora.unavailable).toBeUndefined();
    expect(nora.instructions).not.toMatch(/Not available in this edition/);
    const penny = templateByKey("expense-tracker")!;
    expect(penny.tools).toEqual(["note_read", "note_write", "file_list", "file_read", "file_write", "file_append", "ask_user"]);
    expect(penny.notYet).toEqual(["reading photos", "PDFs", "e-mail to you"]);
    expect(penny.instructions).toMatch(/Not available in this edition: reading photos, PDFs, e-mail to you\. When the job calls for one of them, write the result as a file instead/);
    expect(penny.files.map((f) => f.path)).toEqual(["categories.md"]);
    expect(penny.unavailable).toBeUndefined();
  });

  it("shows, without offering, a recipe whose core is an ability this edition lacks — and says why", () => {
    expect(templateByKey("offer-writer")!.unavailable).toBe("its offers are PDFs sent by e-mail");
    expect(templateByKey("morning-brief")!.unavailable).toBe("it reads web pages and e-mails you the brief");
    expect(templateByKey("trip-splitter")!.unavailable).toBeUndefined();
  });

  it("converts a recipe's schedule to this edition's clock, with its task", () => {
    expect(scheduleOf({ kind: "daily", hour: 7, minute: 30, weekday: 1, task: "Read the pages." })).toEqual({ every: "day", at: "07:30", task: "Read the pages." });
    expect(scheduleOf({ kind: "weekly", hour: 18, minute: 7, weekday: 5, task: "The week." })).toEqual({ every: "week", at: "18:05", weekday: 5, task: "The week." });
    expect(scheduleOf({ kind: "hourly", hour: 0, minute: 0, weekday: 0, task: "Look." })).toEqual({ every: "hour", at: "00:00", task: "Look." });
    expect(templateByKey("morning-brief")!.schedule).toEqual({ every: "day", at: "07:30", task: "Read the pages listed in pages.md and email your owner the morning brief." });
  });

  it("activating makes an ordinary agent with its files, the owner's clock on the schedule, and a fresh id beside the crew's names", () => {
    const penny = activateTemplate(templateByKey("expense-tracker")!, new Set(["briefer", "assistant"]), NOW, "Europe/Rome");
    expect(penny.agent).toMatchObject({ id: "penny", name: "Penny", role: "Tracks your expenses", tier: "auto", memory: false, capUsd: 5, createdAt: NOW, updatedAt: NOW });
    expect(penny.agent.schedule).toBeUndefined();
    expect(penny.files).toEqual([expect.objectContaining({ agent: "penny", path: "categories.md", updatedAt: NOW })]);
    const piet = activateTemplate(templateByKey("morning-brief")!, new Set(), NOW, "Europe/Rome");
    expect(piet.agent.schedule).toEqual({ every: "day", at: "07:30", timeZone: "Europe/Rome", task: "Read the pages listed in pages.md and email your owner the morning brief." });
    const again = activateTemplate(templateByKey("expense-tracker")!, new Set(["penny"]), NOW, "UTC");
    expect(again.agent.id).not.toBe("penny");
    expect(again.agent.id).toMatch(/^penny/);
  });
});
