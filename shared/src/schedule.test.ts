import { describe, expect, it } from "vitest";
import {
  TICK_MINUTES,
  describeSchedule,
  isDue,
  nextRunAt,
  safeTimezone,
  sanitiseSchedule,
  slotIdFor,
  type AgentSchedule,
} from "./schedule";

const daily = (over: Partial<AgentSchedule> = {}): AgentSchedule => ({
  kind: "daily",
  hour: 9,
  minute: 0,
  weekday: 1,
  timezone: "UTC",
  task: "Send me the overnight summary.",
  enabled: true,
  ...over,
});
const at = (iso: string) => new Date(iso);

describe("when a schedule is due", () => {
  it("fires in the tick window, not only on the exact second", () => {
    // EventBridge promises "within the minute", never "on the second". An equality test
    // against the wall clock would skip runs silently, forever.
    expect(isDue(daily(), at("2026-07-27T09:00:00Z"))).toBe(true);
    expect(isDue(daily(), at("2026-07-27T09:04:59Z"))).toBe(true);
  });

  it("does not fire outside its window", () => {
    expect(isDue(daily(), at("2026-07-27T09:05:00Z"))).toBe(false);
    expect(isDue(daily(), at("2026-07-27T08:59:00Z"))).toBe(false);
    expect(isDue(daily(), at("2026-07-27T10:00:00Z"))).toBe(false);
  });

  it("never fires while switched off", () => {
    expect(isDue(daily({ enabled: false }), at("2026-07-27T09:00:00Z"))).toBe(false);
  });

  it("hourly ignores the hour, daily ignores the weekday", () => {
    const hourly = daily({ kind: "hourly", minute: 30 });
    expect(isDue(hourly, at("2026-07-27T03:30:00Z"))).toBe(true);
    expect(isDue(hourly, at("2026-07-27T17:32:00Z"))).toBe(true);
    expect(isDue(hourly, at("2026-07-27T17:40:00Z"))).toBe(false);

    // A Monday and a Thursday both fire for a daily schedule.
    expect(isDue(daily(), at("2026-07-27T09:00:00Z"))).toBe(true);
    expect(isDue(daily(), at("2026-07-30T09:00:00Z"))).toBe(true);
  });

  it("weekly fires on its day and no other", () => {
    const mondays = daily({ kind: "weekly", weekday: 1 });
    expect(isDue(mondays, at("2026-07-27T09:00:00Z"))).toBe(true); // Monday
    expect(isDue(mondays, at("2026-07-28T09:00:00Z"))).toBe(false); // Tuesday
  });

  it("handles midnight, which is where hour arithmetic usually breaks", () => {
    const midnight = daily({ hour: 0, minute: 0 });
    expect(isDue(midnight, at("2026-07-27T00:00:00Z"))).toBe(true);
    expect(isDue(midnight, at("2026-07-27T12:00:00Z"))).toBe(false);
  });
});

// The reason a timezone is stored at all: 09:00 has to stay 09:00 for the person who set
// it, on both sides of a clock change.
describe("timezones", () => {
  it("reads the wall clock in the owner's zone, not the server's", () => {
    const rome = daily({ timezone: "Europe/Rome" });
    // Rome is UTC+2 in July, so 09:00 local is 07:00Z.
    expect(isDue(rome, at("2026-07-27T07:00:00Z"))).toBe(true);
    expect(isDue(rome, at("2026-07-27T09:00:00Z"))).toBe(false);
  });

  it("keeps 09:00 at 09:00 across a daylight-saving change", () => {
    const rome = daily({ timezone: "Europe/Rome" });
    // Late October, Rome is back to UTC+1 — same local time, different UTC instant.
    expect(isDue(rome, at("2026-11-03T08:00:00Z"))).toBe(true);
    expect(isDue(rome, at("2026-11-03T07:00:00Z"))).toBe(false);
  });

  it("falls back to UTC rather than throwing on a bogus zone", () => {
    expect(safeTimezone("Mars/Olympus_Mons")).toBe("UTC");
    expect(safeTimezone(42)).toBe("UTC");
    expect(safeTimezone("Europe/Rome")).toBe("Europe/Rome");
  });
});

// The idempotency rule (CLAUDE.md gotcha #3). A tick that runs twice — a retry, an
// overlapping invocation — must not start the same scheduled run twice.
describe("the slot id is the idempotency key", () => {
  it("is identical for every moment inside one slot", () => {
    const s = daily();
    const a = slotIdFor("a1", s, at("2026-07-27T09:00:00Z"));
    const b = slotIdFor("a1", s, at("2026-07-27T09:04:59Z"));
    expect(a).toBe(b);
  });

  it("differs across slots, days and agents", () => {
    const s = daily();
    expect(slotIdFor("a1", s, at("2026-07-27T09:00:00Z"))).not.toBe(
      slotIdFor("a1", s, at("2026-07-28T09:00:00Z")),
    );
    expect(slotIdFor("a1", s, at("2026-07-27T09:00:00Z"))).not.toBe(
      slotIdFor("a2", s, at("2026-07-27T09:00:00Z")),
    );
  });

  it("contains no clock reading of its own", () => {
    // If the id ever embedded "now" rather than the SLOT, a retry would fork a second run.
    const s = daily();
    expect(slotIdFor("a1", s, at("2026-07-27T09:03:21Z"))).toBe("sched-a1-20260727T0900");
  });
});

describe("what the card promises", () => {
  it("agrees with what the runner will actually do", () => {
    const s = daily({ timezone: "Europe/Rome" });
    const next = nextRunAt(s, at("2026-07-27T06:00:00Z"))!;
    expect(next).toBeTruthy();
    expect(isDue(s, next)).toBe(true); // the promise and the rule are the same code
  });

  it("finds the next weekly slot within the week", () => {
    const s = daily({ kind: "weekly", weekday: 5 });
    const next = nextRunAt(s, at("2026-07-27T10:00:00Z"))!;
    expect(next.getUTCDay()).toBe(5);
  });

  it("says nothing is coming when it's switched off", () => {
    expect(nextRunAt(daily({ enabled: false }), at("2026-07-27T06:00:00Z"))).toBeUndefined();
  });

  it("reads back in plain words", () => {
    expect(describeSchedule(daily())).toBe("Every day at 09:00 (UTC)");
    expect(describeSchedule(daily({ kind: "weekly", weekday: 3, hour: 8, minute: 30 })))
      .toBe("Every Wednesday at 08:30 (UTC)");
    expect(describeSchedule(daily({ kind: "hourly", minute: 15 })))
      .toBe("Every hour at 15 minutes past");
  });
});

describe("nothing a client sends can make a bad schedule", () => {
  it("refuses one with no job to do", () => {
    expect(sanitiseSchedule({ kind: "daily", hour: 9, task: "  " })).toBeUndefined();
    expect(sanitiseSchedule(null)).toBeUndefined();
    expect(sanitiseSchedule("every day")).toBeUndefined();
  });

  it("clamps absurd values instead of trusting them", () => {
    const s = sanitiseSchedule({ kind: "nonsense", hour: 99, minute: -5, weekday: 12, task: "go" })!;
    expect(s.kind).toBe("daily");
    expect(s.hour).toBe(9);
    expect(s.minute).toBe(0);
    expect(s.weekday).toBe(1);
    expect(s.timezone).toBe("UTC");
  });

  it("snaps the minute to the tick, so it can't promise precision we lack", () => {
    expect(sanitiseSchedule({ kind: "daily", hour: 9, minute: 7, task: "go" })!.minute).toBe(5);
    expect(sanitiseSchedule({ kind: "daily", hour: 9, minute: 58, task: "go" })!.minute).toBe(55);
    expect(sanitiseSchedule({ kind: "daily", hour: 9, minute: 7, task: "go" })!.minute % TICK_MINUTES).toBe(0);
  });
});
