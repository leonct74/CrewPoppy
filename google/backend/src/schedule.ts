// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * A schedule is DATA on the agent (DESIGN.md §5b — one ticker, never a rule per agent): plain
 * language, never cron; the owner's own clock; due is a WINDOW, not an equality; idempotent by
 * SLOT. On Google the ticker lives in this backend while the app is open (§18, G3c); a slot the
 * app slept through is run at the next chance within a window, and the run says it was late.
 */

export type Every = "hour" | "day" | "week";

export interface Schedule {
  every: Every;
  /** "HH:MM" in the owner's zone, minutes in steps of five; "every hour" runs on the hour. */
  at: string;
  /** 0 = Sunday … 6 = Saturday; only with "week". */
  weekday?: number;
  timeZone: string;
  /** What the agent is handed on each scheduled run (the live app's own semantics); absent = its brief. */
  task?: string;
}

/** The longest task a schedule carries — the same room as a request. */
export const TASK_MAX = 4_000;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** A slot the app slept through is still run this long after it was due; older ones are let go. */
export const LATE_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Later than this after the slot, the run says it was late. */
export const LATE_AFTER_MS = 5 * 60 * 1000;

export function validateSchedule(input: unknown, defaultZone: string): { schedule?: Schedule; problems: string[] } {
  if (input === null || input === undefined || input === "") return { problems: [] };
  if (typeof input !== "object") return { problems: ["the schedule must be an object"] };
  const s = input as Record<string, unknown>;
  const problems: string[] = [];
  const every = s.every;
  if (every !== "hour" && every !== "day" && every !== "week") problems.push('the schedule must be every "hour", "day" or "week"');
  let at = "00:00";
  if (every !== "hour") {
    const m = typeof s.at === "string" ? /^(\d{1,2}):(\d{2})$/.exec(s.at.trim()) : null;
    const hh = m ? Number(m[1]) : NaN;
    const mm = m ? Number(m[2]) : NaN;
    if (!m || hh > 23 || mm > 59) problems.push("the time must be HH:MM, like 09:00");
    else if (mm % 5 !== 0) problems.push("the minutes must be a multiple of five — the crew looks every five minutes, and 09:07 would promise more than it can keep");
    else at = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  let weekday: number | undefined;
  if (every === "week") {
    const w = Number(s.weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) problems.push("the weekday must be 0 (Sunday) to 6 (Saturday)");
    else weekday = w;
  }
  const timeZone = typeof s.timeZone === "string" && s.timeZone.trim() ? s.timeZone.trim() : defaultZone;
  if (!isTimeZone(timeZone)) problems.push(`"${timeZone}" is not a time zone this crew knows`);
  const task = typeof s.task === "string" ? s.task.trim() : "";
  if (task.length > TASK_MAX) problems.push(`the task is more than ${TASK_MAX.toLocaleString("en-GB")} characters`);
  if (problems.length > 0) return { problems };
  return { schedule: { every: every as Every, at, ...(weekday !== undefined ? { weekday } : {}), timeZone, ...(task ? { task } : {}) }, problems: [] };
}

/**
 * The same schedule as the cron string a cloud scheduler takes, in the schedule's own zone —
 * derived from the data, never typed by anyone (DESIGN §18 G7: the host writes one alarm per slot).
 */
export function cronOf(s: Schedule): string {
  if (s.every === "hour") return "0 * * * *";
  const [H, M] = s.at.split(":").map(Number) as [number, number];
  return s.every === "week" ? `${M} ${H} * * ${s.weekday ?? 1}` : `${M} ${H} * * *`;
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** "every day at 09:00 (Europe/Rome)" — checkable at a glance. */
export function describeSchedule(s: Schedule): string {
  const zone = ` (${s.timeZone})`;
  if (s.every === "hour") return `every hour, on the hour${zone}`;
  if (s.every === "week") return `every ${WEEKDAYS[s.weekday ?? 1]} at ${s.at}${zone}`;
  return `every day at ${s.at}${zone}`;
}

interface Wall {
  y: number;
  m: number;
  d: number;
  H: number;
  M: number;
  wd: number;
}

/** The wall clock in a zone at one instant. */
export function wallIn(zone: string, instantMs: number): Wall {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(instantMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), H: Number(get("hour")) % 24, M: Number(get("minute")), wd: wd < 0 ? 0 : wd };
}

/** The instant of a wall-clock time in a zone (two passes settle a daylight-saving offset). */
export function instantOf(zone: string, y: number, m: number, d: number, H: number, M: number): number {
  const wanted = Date.UTC(y, m - 1, d, H, M);
  let t = wanted;
  for (let i = 0; i < 2; i++) {
    const w = wallIn(zone, t);
    t += wanted - Date.UTC(w.y, w.m - 1, w.d, w.H, w.M);
  }
  return t;
}

const DAY_MS = 86_400_000;
const pad = (n: number): string => String(n).padStart(2, "0");
const slotId = (w: Wall, H: number, M: number): string => `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(H)}${pad(M)}`;

/** The most recent time this schedule was due, at or before `now`: the slot's id and its instant. */
export function lastSlot(s: Schedule, nowIso: string): { slot: string; dueAt: string } {
  const now = Date.parse(nowIso);
  const [H, M] = s.at.split(":").map(Number) as [number, number];
  if (s.every === "hour") {
    const w = wallIn(s.timeZone, now);
    return { slot: slotId(w, w.H, 0), dueAt: new Date(instantOf(s.timeZone, w.y, w.m, w.d, w.H, 0)).toISOString() };
  }
  // Walk back day by day (at most a week) until the slot is at or before now.
  for (let back = 0; back < 8; back++) {
    const w = wallIn(s.timeZone, now - back * DAY_MS);
    if (s.every === "week" && w.wd !== (s.weekday ?? 1)) continue;
    const t = instantOf(s.timeZone, w.y, w.m, w.d, H, M);
    if (t <= now) return { slot: slotId(w, H, M), dueAt: new Date(t).toISOString() };
  }
  const w = wallIn(s.timeZone, now - 7 * DAY_MS);
  return { slot: slotId(w, H, M), dueAt: new Date(instantOf(s.timeZone, w.y, w.m, w.d, H, M)).toISOString() };
}

/** The next time this schedule is due after `now`. */
export function nextDue(s: Schedule, nowIso: string): string {
  const now = Date.parse(nowIso);
  const [H, M] = s.at.split(":").map(Number) as [number, number];
  if (s.every === "hour") {
    const w = wallIn(s.timeZone, now);
    return new Date(instantOf(s.timeZone, w.y, w.m, w.d, w.H, 0) + 3_600_000).toISOString();
  }
  for (let ahead = 0; ahead < 8; ahead++) {
    const w = wallIn(s.timeZone, now + ahead * DAY_MS);
    if (s.every === "week" && w.wd !== (s.weekday ?? 1)) continue;
    const t = instantOf(s.timeZone, w.y, w.m, w.d, H, M);
    if (t > now) return new Date(t).toISOString();
  }
  return new Date(now + 7 * DAY_MS).toISOString();
}

/** "09:00" in the schedule's zone, for the late note. */
export function clockIn(zone: string, iso: string): string {
  const w = wallIn(zone, Date.parse(iso));
  return `${pad(w.H)}:${pad(w.M)}`;
}
