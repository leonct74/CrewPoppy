// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import { CEILING_USD_PER_MILLION_TOKENS, DEFAULT_CAPS, ceilingUsd, describeMeter, emptyMonth, mayCall, recordCall, usd } from "./spend";

const NOW = "2026-09-08T06:30:00.000Z";

describe("the caps and the meter", () => {
  it("never guesses a price: the money line is a ceiling, and says so", () => {
    expect(CEILING_USD_PER_MILLION_TOKENS).toBeGreaterThanOrEqual(10);
    expect(ceilingUsd(1_000_000)).toBe(10);
    expect(usd(0.0012)).toBe("$0.01");
    expect(usd(0)).toBe("$0.00");
    const m = recordCall(recordCall(emptyMonth("2026-09"), 1000, 100, NOW), 500, 50, NOW);
    expect(describeMeter(m, DEFAULT_CAPS)).toBe("This month: 2 model calls · 1,650 tokens, at most $0.02 at the ceiling · limits $10.00 a month at the ceiling, 60 calls a day.");
    expect(describeMeter(emptyMonth("2026-09"), DEFAULT_CAPS)).toMatch(/0 model calls · nothing spent/);
  });

  it("stops at the daily cap, the monthly cap and the token cap — early, never late", () => {
    const caps = { callsPerDay: 2, callsPerMonth: 3, tokensPerMonth: 1000, usdPerMonth: 10 };
    let m = emptyMonth("2026-09");
    expect(mayCall(m, caps, NOW)).toEqual({ ok: true });
    m = recordCall(m, 100, 10, NOW);
    m = recordCall(m, 100, 10, NOW);
    expect(mayCall(m, caps, NOW)).toEqual({ ok: false, reason: "today's limit of 2 model calls is reached" });
    const tomorrow = "2026-09-09T06:30:00.000Z";
    expect(mayCall(m, caps, tomorrow)).toEqual({ ok: true });
    m = recordCall(m, 100, 10, tomorrow);
    expect(mayCall(m, caps, "2026-09-10T06:30:00.000Z")).toEqual({ ok: false, reason: "this month's limit of 3 model calls is reached" });
    const heavy = recordCall(emptyMonth("2026-09"), 900, 100, NOW);
    expect(mayCall(heavy, caps, tomorrow)).toEqual({ ok: false, reason: "this month's limit of 1,000 tokens is reached" });
    const dear = recordCall(emptyMonth("2026-09"), 100, 10, NOW, 10);
    expect(mayCall(dear, { ...caps, tokensPerMonth: 1_000_000 }, tomorrow)).toEqual({ ok: false, reason: "this month's spending limit of $10.00 (at the ceiling) is reached" });
    expect(dear.ceilingUsd).toBe(10);
  });
});
