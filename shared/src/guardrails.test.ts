import { describe, expect, it } from "vitest";
import { checkContinue, checkStart, remainingOutputBudget, sanitiseCaps, newestFirst, oldestFirst } from "./guardrails";
import { TOKEN_RATES, capCostFor, costFor, formatUsd, isEstimatedForCap, monthKeyOf } from "./pricing";
import { DEFAULT_CAPS, type AgentCaps } from "./types";

const caps: AgentCaps = {
  maxIterations: 3,
  maxTokensPerRun: 1000,
  maxWallClockMs: 10_000,
  monthlySpendCapUsd: 5,
};
const fresh = { iterations: 0, usage: { inputTokens: 0, outputTokens: 0 }, elapsedMs: 0, monthSpendUsd: 0 };

describe("caps are hard mechanisms, not advice (DESIGN §7)", () => {
  it("refuses to START a run for an agent already at its monthly cap", () => {
    const v = checkStart(caps, 5);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("monthly_spend_cap");
    // The user is told what to do about it, in money they recognise.
    expect(v.message).toContain("$5.00");
  });

  it("lets a run start while there's budget left", () => {
    expect(checkStart(caps, 4.99).ok).toBe(true);
  });

  it("stops at the iteration limit", () => {
    const v = checkContinue(caps, { ...fresh, iterations: 3 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("max_iterations");
  });

  it("stops at the token limit, counting input AND output", () => {
    const v = checkContinue(caps, { ...fresh, usage: { inputTokens: 600, outputTokens: 400 } });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("max_tokens");
  });

  it("stops at the wall-clock limit", () => {
    const v = checkContinue(caps, { ...fresh, elapsedMs: 10_000 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("max_wall_clock");
  });

  it("stops mid-run when the month's spend crosses the cap", () => {
    const v = checkContinue(caps, { ...fresh, monthSpendUsd: 5.01 });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("monthly_spend_cap");
  });

  it("continues while every limit still has room", () => {
    expect(checkContinue(caps, { iterations: 2, usage: { inputTokens: 500, outputTokens: 400 }, elapsedMs: 9_000, monthSpendUsd: 4.9 }).ok).toBe(true);
  });

  it("never shows the user a raw limit name or a stack trace", () => {
    for (const state of [
      { ...fresh, iterations: 3 },
      { ...fresh, usage: { inputTokens: 1000, outputTokens: 0 } },
      { ...fresh, elapsedMs: 99_999 },
      { ...fresh, monthSpendUsd: 99 },
    ]) {
      const m = checkContinue(caps, state).message ?? "";
      expect(m.length).toBeGreaterThan(10);
      expect(m).not.toMatch(/max_|_cap|undefined|NaN/);
    }
  });
});

describe("output budget can't exceed what's left of the token cap", () => {
  it("shrinks as tokens are consumed", () => {
    expect(remainingOutputBudget(caps, { inputTokens: 900, outputTokens: 0 }, 4096)).toBe(100);
  });
  it("never goes negative", () => {
    expect(remainingOutputBudget(caps, { inputTokens: 5000, outputTokens: 0 }, 4096)).toBe(0);
  });
  it("respects the caller's ceiling when there's plenty of budget", () => {
    expect(remainingOutputBudget({ ...caps, maxTokensPerRun: 1_000_000 }, { inputTokens: 0, outputTokens: 0 }, 4096)).toBe(4096);
  });
});

describe("caps supplied by the client are never trusted", () => {
  it("falls back to safe defaults for missing or nonsense values", () => {
    const c = sanitiseCaps({ maxIterations: undefined, maxTokensPerRun: NaN }, DEFAULT_CAPS);
    expect(c.maxIterations).toBe(DEFAULT_CAPS.maxIterations);
    expect(c.maxTokensPerRun).toBe(DEFAULT_CAPS.maxTokensPerRun);
  });

  it("refuses unlimited or negative caps — an uncapped agent must be impossible", () => {
    const c = sanitiseCaps(
      { maxIterations: 1e9, maxTokensPerRun: -1, maxWallClockMs: 0, monthlySpendCapUsd: -50 },
      DEFAULT_CAPS,
    );
    expect(c.maxIterations).toBeLessThanOrEqual(50);
    expect(c.maxTokensPerRun).toBeGreaterThan(0);
    expect(c.maxWallClockMs).toBeGreaterThan(0);
    expect(c.monthlySpendCapUsd).toBeGreaterThanOrEqual(0);
  });

  it("keeps the wall-clock under Lambda's own ceiling", () => {
    expect(sanitiseCaps({ maxWallClockMs: 99_999_999 }, DEFAULT_CAPS).maxWallClockMs).toBeLessThan(900_000);
  });

  it("ships safe defaults out of the box", () => {
    expect(DEFAULT_CAPS.maxIterations).toBe(8); // DESIGN §14.6
    expect(DEFAULT_CAPS.monthlySpendCapUsd).toBe(10); // DESIGN §14.6
  });
});

describe("cost is only ever shown when we actually know the rate", () => {
  it("computes from measured per-token rates", () => {
    const c = costFor("qwen.qwen3-32b-v1:0", { inputTokens: 1000, outputTokens: 1000 });
    expect(c.usd).toBeCloseTo(0.00009 + 0.00035, 8);
    expect(c.approx).toBe(true);
  });

  it("returns NO price for a model we have no verified rate for, rather than guessing", () => {
    const c = costFor("anthropic.claude-haiku-4-5-20251001-v1:0", { inputTokens: 1000, outputTokens: 1000 });
    expect(c.usd).toBeUndefined();
    expect(c.usage.inputTokens).toBe(1000); // tokens are still reported
  });

  it("never renders a real cost as $0.00", () => {
    // A run that cost a fraction of a cent must not read as free — that would quietly
    // undermine the entire cost meter.
    expect(formatUsd(0.00021)).toBe("$0.0002");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("buckets spend by calendar month", () => {
    expect(monthKeyOf("2026-07-26T10:00:00.000Z")).toBe("2026-07");
  });
});

// Regression from a live run: a Claude run recorded 175/288 tokens and $0 spend,
// because no per-token rate is published for it. A monthly cap that can never be
// reached is not a cap — so cap accounting must never depend on knowing the price.
describe("the spend cap works even for models with no published price", () => {
  it("charges an unpriced model against the cap instead of nothing", () => {
    const usage = { inputTokens: 175, outputTokens: 288 };
    expect(costFor("anthropic.claude-sonnet-4-5-20250929-v1:0", usage).usd).toBeUndefined();
    expect(capCostFor("anthropic.claude-sonnet-4-5-20250929-v1:0", usage)).toBeGreaterThan(0);
  });

  it("errs upward: the assumed rate is at least as high as any model we do price", () => {
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    for (const modelId of Object.keys(TOKEN_RATES)) {
      expect(capCostFor("some.unpriced-model", usage)).toBeGreaterThanOrEqual(capCostFor(modelId, usage));
    }
  });

  it("uses the real rate when we have one, rather than the ceiling", () => {
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    expect(capCostFor("qwen.qwen3-32b-v1:0", usage)).toBeCloseTo(0.00009 + 0.00035, 8);
    expect(isEstimatedForCap("qwen.qwen3-32b-v1:0")).toBe(false);
    expect(isEstimatedForCap("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(true);
  });
});

describe("run order comes from the CLOCK, never the sort key", () => {
  // 🪤 The live bug (2026-07-31): a run's sort key is `run#<uuid>`, so DynamoDB's own
  // ordering is random. These ids are deliberately chosen so key order and time order
  // DISAGREE — sorting by id would put yesterday's run after today's.
  const runs = [
    { runId: "zzz", startedAt: "2026-07-30T09:00:00.000Z" },
    { runId: "aaa", startedAt: "2026-07-31T09:00:00.000Z" },
    { runId: "mmm", startedAt: "2026-07-30T18:00:00.000Z" },
  ];

  it("newestFirst puts the most recent first", () => {
    expect(newestFirst(runs).map((r) => r.runId)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("oldestFirst is chat order — top of the thread to the bottom", () => {
    expect(oldestFirst(runs).map((r) => r.runId)).toEqual(["zzz", "mmm", "aaa"]);
  });

  it("does not mutate the caller's array", () => {
    const original = [...runs];
    newestFirst(runs);
    expect(runs).toEqual(original);
  });
});
