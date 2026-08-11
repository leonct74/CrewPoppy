// The recipe catalogue is DATA, so these tests are its only compiler: a typo'd tool
// name would otherwise ship as a checkbox that silently doesn't exist, and a bad
// workspace path would be caught much later, by the dispatcher, in someone's AWS.
import { describe, expect, it } from "vitest";
import { RECIPES } from "./recipes";
import { isToolName, isSafeRelativePath } from "./tools";

describe("the recipe catalogue is internally sound", () => {
  it("has unique keys and names", () => {
    expect(new Set(RECIPES.map((r) => r.key)).size).toBe(RECIPES.length);
    expect(new Set(RECIPES.map((r) => r.name)).size).toBe(RECIPES.length);
  });

  it("names only tools that exist — a typo here becomes a checkbox that isn't real", () => {
    for (const r of RECIPES) {
      expect(r.tools.length, r.key).toBeGreaterThan(0);
      for (const t of r.tools) expect(isToolName(t), `${r.key}: ${t}`).toBe(true);
    }
  });

  it("uses valid avatar ids from the built-in catalogue", () => {
    for (const r of RECIPES) expect(r.avatar, r.key).toMatch(/^av-(0[1-9]|[1-4][0-9]|50)$/);
  });

  it("writes only safe workspace paths", () => {
    for (const r of RECIPES) {
      for (const f of r.files ?? []) {
        expect(isSafeRelativePath(f.path), `${r.key}: ${f.path}`).toBe(true);
        expect(f.content.trim().length, `${r.key}: ${f.path}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps schedules inside the shapes the ticker understands", () => {
    for (const r of RECIPES) {
      if (!r.schedule) continue;
      expect(["hourly", "daily", "weekly"], r.key).toContain(r.schedule.kind);
      expect(r.schedule.hour, r.key).toBeGreaterThanOrEqual(0);
      expect(r.schedule.hour, r.key).toBeLessThanOrEqual(23);
      expect(r.schedule.minute, r.key).toBeGreaterThanOrEqual(0);
      expect(r.schedule.minute, r.key).toBeLessThanOrEqual(59);
      expect(r.schedule.weekday, r.key).toBeGreaterThanOrEqual(0);
      expect(r.schedule.weekday, r.key).toBeLessThanOrEqual(6);
      expect(r.schedule.task.trim().length, r.key).toBeGreaterThan(0);
    }
  });

  it("gives every web-reading recipe a token budget that survives a page", () => {
    // One fetched page is ~10k tokens (DESIGN §4f); the 20k default dies on the second
    // page. A recipe that suggests web_fetch without also sizing the budget ships an
    // agent that fails mid-task on its first real job.
    for (const r of RECIPES) {
      if (!r.tools.includes("web_fetch")) continue;
      expect(r.maxTokensPerRun ?? 0, `${r.key} needs maxTokensPerRun ≥ 30000`).toBeGreaterThanOrEqual(30_000);
    }
  });

  it("stays within the caps the backend will accept", () => {
    for (const r of RECIPES) {
      expect(r.capUsd, r.key).toBeGreaterThan(0);
      if (r.maxTokensPerRun !== undefined) {
        expect(r.maxTokensPerRun, r.key).toBeGreaterThanOrEqual(100);
        expect(r.maxTokensPerRun, r.key).toBeLessThanOrEqual(500_000);
      }
    }
  });

  it("speaks to the owner on every card", () => {
    for (const r of RECIPES) {
      expect(r.blurb.trim().length, r.key).toBeGreaterThan(20);
      expect(r.instructions.trim().length, r.key).toBeGreaterThan(50);
      expect(r.role.trim().length, r.key).toBeGreaterThan(0);
    }
  });
});
