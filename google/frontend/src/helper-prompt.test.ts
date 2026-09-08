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
  });

  it("states the non-negotiables as constraints to plan within", () => {
    for (const r of FORM.rules) expect(prompt).toContain(r);
  });

  it("demands a fixed answer shape that maps onto the form, asks for at most three questions, and ends mid-sentence", () => {
    expect(prompt).toContain("ANSWER IN EXACTLY THIS SHAPE:\n1. Name: …\n2. Role: …\n3. Brief: …\n4. Model: one of the four labels above, exactly as written\n5. May read my memory: yes or no, with one line why\n6. Monthly limit: a whole number of dollars");
    expect(prompt).toContain("at most three short questions");
    expect(prompt.endsWith("MY AGENT SHOULD: ")).toBe(true);
  });

  it("changes the instant the catalogue does — no hand-maintained copy", () => {
    const changed = { ...FORM, tiers: [...FORM.tiers, { value: "deep" as const, label: "Colossal", note: "for testing" }] };
    expect(buildHelperPrompt(changed)).toContain('"Colossal" — for testing');
  });
});
