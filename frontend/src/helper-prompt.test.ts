import { describe, expect, it } from "vitest";
import { buildHelperPrompt } from "./helper-prompt";
import type { ModelChoice, ToolCatalogue } from "./types";

// The helper prompt IS the user's training, pasted into a foreign AI. Its one job is to
// never disagree with the form: every capability the form offers appears, described in
// the form's own words, and nothing invented.
describe("the AI helper prompt", () => {
  const catalogue: ToolCatalogue = {
    tools: [
      { name: "save_pdf", label: "Save PDFs", what: "Turn its work into a PDF file.", risk: undefined },
      {
        name: "send_email",
        label: "Email other people",
        what: "Propose emails to anyone.",
        risk: "Every send to an outsider waits for your approval.",
      },
    ],
    groups: [{ key: "work", label: "Its work", what: "what it produces", tools: ["save_pdf", "send_email"] }],
    needsEmail: ["send_email"],
  };
  const models: ModelChoice[] = [
    { id: "m1", label: "Claude Sonnet", provider: "Anthropic", goodAt: "Everyday work.", toolUse: true, vision: false, cost: "$$", formLikely: false, ready: true },
    { id: "m2", label: "Undrivable", provider: "X", goodAt: "n/a", toolUse: true, vision: false, cost: "$", formLikely: false, ready: true, supported: false },
  ];

  it("carries every capability with the form's own label and note", () => {
    const p = buildHelperPrompt(catalogue, models);
    expect(p).toContain('"Save PDFs" — Turn its work into a PDF file.');
    expect(p).toContain('"Email other people"');
    expect(p).toContain("caution: Every send to an outsider waits for your approval.");
  });

  it("offers only models the engine can actually drive", () => {
    const p = buildHelperPrompt(catalogue, models);
    expect(p).toContain("Claude Sonnet");
    expect(p).not.toContain("Undrivable");
  });

  it("tells the user about MailPoppy when the agent needs its own address (founder, 2026-07-30)", () => {
    const p = buildHelperPrompt(catalogue, models);
    expect(p).toContain("created with MailPoppy");
    expect(p).toContain("Assign this mailbox to an AI agent");
    // …and stays honest: mail to the owner's own address needs no second poppy (DESIGN §15d).
    expect(p).toMatch(/MY OWN address work without MailPoppy/);
  });

  it("states the non-negotiables the AI must plan within", () => {
    const p = buildHelperPrompt(catalogue, models);
    expect(p).toMatch(/ALWAYS pause for my explicit approval/);
    expect(p).toMatch(/instructions never grant abilities/i);
    expect(p).toMatch(/ANSWER IN EXACTLY THIS SHAPE/);
    // It ends mid-sentence on purpose: the user's next words ARE the job description.
    expect(p.trimEnd().endsWith("MY AGENT SHOULD:")).toBe(true);
  });
});
