// Agents that run themselves (DESIGN §5, P3).
//
// THE IMPLEMENTATION DECISION (recorded per CLAUDE.md: implementation questions get
// decided here): ONE ticker for the whole install, not one EventBridge rule per agent.
//
// A rule per agent would mean the sidecar creating and deleting AWS resources every time
// somebody edits a schedule — which needs events:PutRule/PutTargets plus
// lambda:AddPermission at RUNTIME, grows the manifest by ~10 actions against the STS
// packed-policy budget that already bit us once (§2b), leaves per-agent resources to be
// swept at teardown, and puts a failure mode between "I set a schedule" and "it saved".
//
// Instead: the stack owns ONE EventBridge rule that pokes the runner on a fixed tick. A
// schedule is then just DATA on the agent, exactly like its tools and its caps — free to
// change, nothing to provision, nothing to leak, and it disappears with the agent.
//
// The cost of a tick is real but negligible (one short Lambda invocation every few
// minutes, comfortably inside the free tier), and it buys back the "$0 when idle" promise
// everywhere else: an agent with no schedule is still just a row.

/** How often the stack's rule pokes the runner. Sets the finest granularity we can offer. */
export const TICK_MINUTES = 5;

export type ScheduleKind = "hourly" | "daily" | "weekly";

/**
 * When an agent should run itself, in the terms an owner thinks in — never a cron string.
 * "Every day at 09:00" is a thing people can check at a glance; `0 9 * * *` is a thing
 * people get wrong.
 */
export interface AgentSchedule {
  kind: ScheduleKind;
  /** 0–23, in `timezone`. Ignored for hourly. */
  hour: number;
  /** 0–59, in `timezone`. */
  minute: number;
  /** 0 = Sunday. Weekly only. */
  weekday: number;
  /** IANA zone, e.g. "Europe/Rome". Stored so 09:00 stays 09:00 across a clock change. */
  timezone: string;
  /** The task handed to the agent on each run — a schedule without a job does nothing. */
  task: string;
  enabled: boolean;
}

const HOURS = 60 * 60 * 1000;

function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** A valid IANA zone, or UTC. Never trust the client: an invalid zone throws in Intl. */
export function safeTimezone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Clamp anything a client sends into a schedule that can't misbehave. */
export function sanitiseSchedule(input: unknown): AgentSchedule | undefined {
  if (!input || typeof input !== "object") return undefined;
  const s = input as Record<string, unknown>;
  const kind: ScheduleKind =
    s.kind === "hourly" || s.kind === "weekly" ? s.kind : "daily";
  const task = typeof s.task === "string" ? s.task.trim().slice(0, 20_000) : "";
  if (!task) return undefined; // a schedule with no job is not a schedule
  return {
    kind,
    hour: int(s.hour, 0, 23, 9),
    // Snapped to the tick: offering 09:07 when the ticker only wakes every 5 minutes
    // would promise a precision we don't have.
    minute: Math.min(55, Math.round(int(s.minute, 0, 59, 0) / TICK_MINUTES) * TICK_MINUTES),
    weekday: int(s.weekday, 0, 6, 1),
    timezone: safeTimezone(s.timezone),
    task,
    enabled: s.enabled !== false,
  };
}

/** The wall-clock parts of `at`, as read in `timezone`. */
function partsIn(at: Date, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const got: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) got[p.type] = p.value;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    y: Number(got.year),
    mo: Number(got.month),
    d: Number(got.day),
    // "24" is how en-US hour12:false renders midnight; every other hour is itself.
    h: Number(got.hour) % 24,
    mi: Number(got.minute),
    wd: Math.max(0, days.indexOf(got.weekday ?? "Sun")),
  };
}

/**
 * Is this schedule due in the tick window ending at `now`?
 *
 * Deliberately a WINDOW rather than an equality test: the ticker fires on EventBridge's
 * schedule, which is "within the minute", not "on the second". Asking whether the wall
 * clock reads exactly 09:00 would silently skip runs forever.
 *
 * The window is the tick length, and the caller's idempotent run id (`slotIdFor`) is what
 * stops a slow or duplicated tick from starting the same run twice.
 */
export function isDue(schedule: AgentSchedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  const p = partsIn(now, schedule.timezone);
  const minutesInto = p.mi % 60;
  const withinWindow = (target: number) => {
    const diff = (minutesInto - target + 60) % 60;
    return diff < TICK_MINUTES;
  };
  if (schedule.kind === "hourly") return withinWindow(schedule.minute);
  if (!withinWindow(schedule.minute)) return false;
  if (p.h !== schedule.hour) return false;
  return schedule.kind === "daily" || p.wd === schedule.weekday;
}

/**
 * The id for the slot `now` falls in — the idempotency key (CLAUDE.md gotcha #3).
 *
 * Two ticks that both see the same due slot produce the SAME run id, so the second write
 * overwrites the first rather than starting a second run. `new Date()` is never a
 * fallback here, which is the whole point: the id must be a function of the slot, not of
 * the moment the code happened to run.
 */
export function slotIdFor(agentId: string, schedule: AgentSchedule, now: Date): string {
  const p = partsIn(now, schedule.timezone);
  const slotMinute = Math.floor(p.mi / TICK_MINUTES) * TICK_MINUTES;
  const stamp = `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(slotMinute)}`;
  return `sched-${agentId}-${stamp}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * When this schedule next fires, for the UI. Found by walking tick by tick rather than by
 * calendar arithmetic — it reuses `isDue`, so what the card promises and what the runner
 * does can never drift apart. A week of ticks is a few thousand cheap comparisons.
 */
export function nextRunAt(schedule: AgentSchedule, from: Date): Date | undefined {
  if (!schedule.enabled) return undefined;
  const step = TICK_MINUTES * 60 * 1000;
  const start = Math.ceil((from.getTime() + 1) / step) * step;
  const limit = 8 * 24 * (HOURS / step); // a little over a week of ticks
  for (let i = 0; i < limit; i++) {
    const at = new Date(start + i * step);
    if (isDue(schedule, at)) return at;
  }
  return undefined;
}

/** "Every day at 09:00 (Europe/Rome)" — the schedule read back in the owner's words. */
export function describeSchedule(schedule: AgentSchedule): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const time = `${pad(schedule.hour)}:${pad(schedule.minute)}`;
  const where = schedule.timezone === "UTC" ? "UTC" : schedule.timezone.replace(/_/g, " ");
  if (schedule.kind === "hourly") return `Every hour at ${pad(schedule.minute)} minutes past`;
  if (schedule.kind === "daily") return `Every day at ${time} (${where})`;
  return `Every ${days[schedule.weekday]} at ${time} (${where})`;
}
