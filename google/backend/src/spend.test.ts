// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import { CEILING_USD_PER_MILLION_TOKENS, DEFAULT_CAPS, agentUsage, ceilingUsd, describeMeter, emptyMonth, listUsd, mayCall, recordCall, usd, usdFine } from "./spend";

const NOW = "2026-09-08T06:30:00.000Z";

describe("the caps and the meter", () => {
  it("shows the tokens and Google's price for them, and names the ceiling only as the hard stop (founder, 2026-09-08)", () => {
    expect(CEILING_USD_PER_MILLION_TOKENS).toBeGreaterThanOrEqual(10);
    expect(ceilingUsd(1_000_000)).toBe(10);
    expect(usd(0.0012)).toBe("$0.01");
    expect(usd(0)).toBe("$0.00");
    expect(usdFine(0.000297)).toBe("$0.0003");
    expect(usdFine(0.0349)).toBe("$0.03");
    const flashLite = { in: 0.1, out: 0.4 };
    expect(listUsd(963, 239, flashLite)).toBeCloseTo(0.0001919, 9);
    let m = recordCall(emptyMonth("2026-09"), 1000, 100, NOW, ceilingUsd(1100, 5), "emma", listUsd(1000, 100, flashLite));
    m = recordCall(m, 500, 50, NOW, ceilingUsd(550, 5), "emma", listUsd(500, 50, flashLite));
    expect(describeMeter(m, DEFAULT_CAPS)).toBe("This month: 2 model calls · 1,650 tokens (1,500 in, 150 out) ≈ $0.0002 at Google's prices · hard stop at $10.00 on CrewPoppy's safety ceiling, 60 calls a day.");
    expect(agentUsage(m, "emma")).toEqual({ tokens: 1650, listUsd: expect.closeTo(0.00021, 6), ceilingUsd: expect.closeTo(0.00825, 6) });
    expect(agentUsage(m, "nico")).toEqual({ tokens: 0, listUsd: 0, ceilingUsd: 0 });
    expect(describeMeter(emptyMonth("2026-09"), DEFAULT_CAPS)).toMatch(/0 model calls · no tokens · hard stop/);
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
