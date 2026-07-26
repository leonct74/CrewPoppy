import { describe, expect, it } from "vitest";
import { withStaleness } from "./agents";
import { DEFAULT_CAPS, type RunRecord } from "@crewpoppy/shared";

const base: RunRecord = {
  runId: "r1",
  agentId: "a1",
  status: "running",
  input: "Do the thing",
  cost: { usage: { inputTokens: 0, outputTokens: 0 } },
  iterations: 0,
  startedAt: "2026-07-26T10:00:00.000Z",
  modelId: "qwen.qwen3-32b-v1:0",
};
const at = (iso: string) => Date.parse(iso);

// Regression: two real runs sat at "running" forever because the deployed Lambda was
// the empty P0 stub and never reported back. A run must never spin indefinitely.
describe("a run that never reports back is not 'still running'", () => {
  it("leaves a genuinely fresh run alone", () => {
    const r = withStaleness(base, DEFAULT_CAPS, at("2026-07-26T10:00:30.000Z"));
    expect(r.status).toBe("running");
  });

  it("still allows for a slow run inside its own wall-clock cap", () => {
    // 100s in, against a 120s cap — slow, but legitimately working.
    const r = withStaleness(base, DEFAULT_CAPS, at("2026-07-26T10:01:40.000Z"));
    expect(r.status).toBe("running");
  });

  it("marks a run failed once it is past its cap plus a generous margin", () => {
    const r = withStaleness(base, DEFAULT_CAPS, at("2026-07-26T10:10:00.000Z"));
    expect(r.status).toBe("failed");
    // …and points at the actual cause rather than blaming the model.
    expect(r.message).toMatch(/never reported back/i);
    expect(r.message).toMatch(/out of date/i);
  });

  it("respects a longer wall-clock cap before declaring anything wrong", () => {
    const caps = { ...DEFAULT_CAPS, maxWallClockMs: 600_000 };
    const r = withStaleness(base, caps, at("2026-07-26T10:05:00.000Z"));
    expect(r.status).toBe("running");
  });

  it("never rewrites a run that already finished", () => {
    for (const status of ["succeeded", "failed", "stopped"] as const) {
      const done = { ...base, status, finishedAt: "2026-07-26T10:00:10.000Z" };
      expect(withStaleness(done, DEFAULT_CAPS, at("2026-08-01T00:00:00.000Z"))).toEqual(done);
    }
  });

  it("does not choke on an unparseable start time", () => {
    const bad = { ...base, startedAt: "not-a-date" };
    expect(withStaleness(bad, DEFAULT_CAPS, Date.now()).status).toBe("running");
  });
});
