// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import { FORM, buildHelperPrompt } from "./helper-prompt";

describe("the helper prompt", () => {
  const prompt = buildHelperPrompt();

  it("is built from the form's own catalogue — every field, every model option, the memory toggle, the cap", () => {
    for (const f of FORM.fields) expect(prompt).toContain(`${f.label} — ${f.note}`);
    for (const t of FORM.tiers) expect(prompt).toContain(`"${t.label}" — ${t.note}`);
    expect(prompt).toContain(`${FORM.memory.label} — ${FORM.memory.note}`);
    expect(prompt).toContain(`${FORM.cap.label} — ${FORM.cap.note}`);
    expect(prompt).toContain(`${FORM.schedule.label} — ${FORM.schedule.note}`);
  });

  it("lists the tools from the backend's fixed catalogue, grouped as the owner is asked, with their honest caveats", () => {
    expect(FORM.tools.map((g) => g.key)).toEqual(["own", "you"]);
    for (const g of FORM.tools) {
      expect(prompt).toContain(`${g.label} — ${g.what}`);
      for (const t of g.tools) expect(prompt).toContain(`"${t.label}" — ${t.what}`);
    }
    expect(prompt).toContain("(Strongly recommended for anything you would want to see first.)");
    expect(FORM.tools.flatMap((g) => g.tools).every((t) => t.default)).toBe(true);
  });

  it("states the non-negotiables as constraints to plan within", () => {
    for (const r of FORM.rules) expect(prompt).toContain(r);
  });

  it("demands a fixed answer shape that maps onto the form, asks for at most three questions, and ends mid-sentence", () => {
    expect(prompt).toContain("ANSWER IN EXACTLY THIS SHAPE:\n1. Name: …\n2. Role: …\n3. Brief: …\n4. Model: one of the four labels above, exactly as written\n5. May read my memory: yes or no, with one line why\n6. Tools: the labels to tick, one per line, each with one line why — and which to leave unticked\n7. Runs by itself: off, or \"every hour\", \"every day at HH:MM\" or \"every <weekday> at HH:MM\"\n8. Monthly limit: a whole number of dollars");
    expect(prompt).toContain("at most three short questions");
    expect(prompt.endsWith("MY AGENT SHOULD: ")).toBe(true);
  });

  it("changes the instant the catalogue does — no hand-maintained copy", () => {
    const changed = { ...FORM, tiers: [...FORM.tiers, { value: "deep" as const, label: "Colossal", note: "for testing" }] };
    expect(buildHelperPrompt(changed)).toContain('"Colossal" — for testing');
  });
});
