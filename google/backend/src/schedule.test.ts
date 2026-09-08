// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import { clockIn, describeSchedule, instantOf, lastSlot, nextDue, validateSchedule } from "./schedule";

describe("a schedule in plain words", () => {
  it("is validated in the user's words and normalised", () => {
    expect(validateSchedule({ every: "day", at: "9:00" }, "Europe/Rome")).toEqual({ schedule: { every: "day", at: "09:00", timeZone: "Europe/Rome" }, problems: [] });
    expect(validateSchedule({ every: "hour", at: "whatever" }, "Europe/Rome")).toEqual({ schedule: { every: "hour", at: "00:00", timeZone: "Europe/Rome" }, problems: [] });
    expect(validateSchedule({ every: "week", at: "18:30", weekday: 5, timeZone: "America/New_York" }, "UTC")).toEqual({ schedule: { every: "week", at: "18:30", weekday: 5, timeZone: "America/New_York" }, problems: [] });
    expect(validateSchedule({ every: "week", at: "18:30" }, "UTC").problems).toEqual(["the weekday must be 0 (Sunday) to 6 (Saturday)"]);
    expect(validateSchedule({ every: "day", at: "25:00" }, "UTC").problems).toEqual(["the time must be HH:MM, like 09:00"]);
    expect(validateSchedule({ every: "month" }, "UTC").problems[0]).toMatch(/every "hour", "day" or "week"/);
    expect(validateSchedule({ every: "day", at: "09:00", timeZone: "Mars/Olympus" }, "UTC").problems).toEqual(['"Mars/Olympus" is not a time zone this crew knows']);
    expect(validateSchedule(null, "UTC")).toEqual({ problems: [] });
    expect(describeSchedule({ every: "day", at: "09:00", timeZone: "Europe/Rome" })).toBe("every day at 09:00 (Europe/Rome)");
    expect(describeSchedule({ every: "week", at: "09:00", weekday: 1, timeZone: "Europe/Rome" })).toBe("every Monday at 09:00 (Europe/Rome)");
    expect(describeSchedule({ every: "hour", at: "00:00", timeZone: "UTC" })).toBe("every hour, on the hour (UTC)");
  });

  it("finds the last slot and the next due time on the owner's clock — a day, a week, an hour", () => {
    const day = { every: "day" as const, at: "09:00", timeZone: "Europe/Rome" };
    expect(lastSlot(day, "2026-09-08T07:30:00.000Z")).toEqual({ slot: "2026-09-08T0900", dueAt: "2026-09-08T07:00:00.000Z" });
    expect(nextDue(day, "2026-09-08T07:30:00.000Z")).toBe("2026-09-09T07:00:00.000Z");
    expect(lastSlot(day, "2026-09-08T06:30:00.000Z")).toEqual({ slot: "2026-09-07T0900", dueAt: "2026-09-07T07:00:00.000Z" });
    expect(nextDue(day, "2026-09-08T06:30:00.000Z")).toBe("2026-09-08T07:00:00.000Z");
    const week = { every: "week" as const, at: "09:00", weekday: 1, timeZone: "Europe/Rome" };
    expect(lastSlot(week, "2026-09-08T07:30:00.000Z")).toEqual({ slot: "2026-09-07T0900", dueAt: "2026-09-07T07:00:00.000Z" });
    expect(nextDue(week, "2026-09-08T07:30:00.000Z")).toBe("2026-09-14T07:00:00.000Z");
    const hour = { every: "hour" as const, at: "00:00", timeZone: "Europe/Rome" };
    expect(lastSlot(hour, "2026-09-08T07:30:00.000Z")).toEqual({ slot: "2026-09-08T0900", dueAt: "2026-09-08T07:00:00.000Z" });
    expect(nextDue(hour, "2026-09-08T07:30:00.000Z")).toBe("2026-09-08T08:00:00.000Z");
    expect(clockIn("Europe/Rome", "2026-09-08T07:31:00.000Z")).toBe("09:31");
  });

  it("keeps 09:00 at 09:00 across the daylight-saving change", () => {
    const day = { every: "day" as const, at: "09:00", timeZone: "Europe/Rome" };
    expect(instantOf("Europe/Rome", 2026, 10, 24, 9, 0)).toBe(Date.parse("2026-10-24T07:00:00.000Z"));
    expect(instantOf("Europe/Rome", 2026, 10, 26, 9, 0)).toBe(Date.parse("2026-10-26T08:00:00.000Z"));
    expect(lastSlot(day, "2026-10-26T08:30:00.000Z")).toEqual({ slot: "2026-10-26T0900", dueAt: "2026-10-26T08:00:00.000Z" });
    expect(nextDue(day, "2026-10-24T08:30:00.000Z")).toBe("2026-10-25T08:00:00.000Z");
  });
});
