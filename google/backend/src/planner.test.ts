// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import { TIERS, classify, memoryQueryOf } from "./planner";

describe("the Planner", () => {
  it("answers a calendar question from the memory alone — no model, no tokens", () => {
    expect(classify("What's on my calendar today?")).toMatchObject({ tier: "none", lookup: "next", wantsMemory: true });
    expect(classify("when did I last meet Anna?")).toMatchObject({ tier: "none", lookup: "last-met" });
    expect(classify("who is Anna Rossi")).toMatchObject({ tier: "none", lookup: "who" });
  });

  it("sends a light task to the cheapest model, an ordinary one to the standard, a hard one to the deep", () => {
    expect(classify("Rewrite this more politely: I need the report by Friday.")).toMatchObject({ tier: "light" });
    expect(classify("How long does the flight from Amsterdam to Rome take?")).toMatchObject({ tier: "light", why: "a short question" });
    expect(classify("Draft a message to the people I met at Cozy Code last week, thanking them and proposing a follow-up meeting in October.")).toMatchObject({ tier: "standard", wantsMemory: true });
    expect(classify("Plan a three-month strategy for launching MemoryPoppy in Italy, with the trade-offs of each channel.")).toMatchObject({ tier: "deep" });
    expect(classify("What is X? Why does it matter? How do I start?")).toMatchObject({ tier: "deep", why: "several questions at once" });
    expect(classify("word ".repeat(130).trim())).toMatchObject({ tier: "deep", why: "a long request" });
  });

  it("obeys the user's choice, and still knows whether the memory should be read", () => {
    expect(classify("What did Anna and I discuss at the board meeting?", "best")).toMatchObject({ tier: "deep", why: "you asked for the best model", wantsMemory: true });
    expect(classify("Write a haiku about rain", "quick")).toMatchObject({ tier: "light", wantsMemory: false });
    expect(classify("What's on my calendar today?", "standard")).toMatchObject({ tier: "standard", wantsMemory: true });
  });

  it("searches the memory with the request's own words, stop words dropped", () => {
    expect(memoryQueryOf("When did I last meet Anna Rossi about the board?")).toBe("meet anna rossi board");
    expect(memoryQueryOf("What's on my calendar today?")).toBe("what's calendar today");
  });

  it("prices every tier at a ceiling above its published rate, and the free tier at nothing", () => {
    expect(TIERS.none.ceilingUsdPerMillion).toBe(0);
    expect(TIERS.light.ceilingUsdPerMillion).toBeLessThan(TIERS.standard.ceilingUsdPerMillion);
    expect(TIERS.standard.ceilingUsdPerMillion).toBeLessThan(TIERS.deep.ceilingUsdPerMillion);
    expect(TIERS.deep.model).toBe("gemini-2.5-pro");
  });
});
