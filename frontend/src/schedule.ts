// The one piece of schedule logic the UI needs: reading a schedule back in words.
// Mirrors @crewpoppy/shared's describeSchedule — the sidecar is a separate process, so
// the frontend keeps its own copy of the wire contract rather than importing across it.

import type { AgentSchedule } from "./types";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Short on purpose — this sits on a crowded card. The zone is left off because the times
 * are already in the reader's own clock; the editor spells it out where there's room.
 */
export function describeSchedule(schedule: AgentSchedule): string {
  const time = `${pad(schedule.hour)}:${pad(schedule.minute)}`;
  if (schedule.kind === "hourly") return `Every hour at ${pad(schedule.minute)} past`;
  if (schedule.kind === "daily") return `Every day at ${time}`;
  return `Every ${DAYS[schedule.weekday]} at ${time}`;
}
