// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import { JUDGE_INSTRUCTIONS, judgeTier, judgeWords } from "./judge";
import { scriptedModel } from "./testing";

describe("the light-model judge", () => {
  it("asks the smallest model for one word, and reads it whatever the casing — or gives up quietly", async () => {
    const m = scriptedModel([], " Deep.\n");
    expect(await judgeTier(m, "Compare the two offers")).toEqual({ tier: "deep", promptTokens: 20, outputTokens: 2, model: "gemini-2.5-flash-lite" });
    expect(m.generated[0]).toEqual({ system: JUDGE_INSTRUCTIONS, user: "REQUEST:\nCompare the two offers", model: "gemini-2.5-flash-lite" });
    expect(await judgeTier(scriptedModel([], "banana"), "x")).toBeNull();
    const failing = scriptedModel([]);
    failing.generate = async () => {
      throw new Error("busy");
    };
    expect(await judgeTier(failing, "x")).toBeNull();
    expect(judgeWords("light")).toBe("the small model judged it a light task");
    expect(judgeWords("standard")).toBe("the small model judged it an ordinary task");
    expect(judgeWords("deep")).toBe("the small model judged it a task that needs reasoning");
  });
});
