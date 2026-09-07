// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The Briefer — the crew's first member on Google Cloud (DESIGN.md §18). Given the meetings
 * around today and the people in them, it writes the brief in plain words. No model in this
 * release: memory before models. When Vertex AI joins (the next release, under the user's card),
 * the model writes from exactly this material and the reads stay the same receipts.
 */
import type { Memory } from "@agentspoppy/core";

export interface BriefInput {
  events: Memory[];
  people: Memory[];
  /** ISO instant — "now". */
  now: string;
  timeZone: string;
  locale?: string;
}

export interface BriefLine {
  /** "Today" · "Coming up" · "Recently". */
  section: string;
  text: string;
  memoryId: string;
}

export interface Brief {
  greeting: string;
  lines: BriefLine[];
  /** The whole brief, as one text. */
  text: string;
  /** Ids of every memory the brief drew on — events and people. */
  memoryIds: string[];
}

const dayKey = (d: Date, timeZone: string, locale?: string): string => d.toLocaleDateString(locale ?? "en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

export function greetingFor(now: Date, timeZone: string): string {
  const hour = Number(now.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", hour12: false }).slice(0, 2));
  return hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function startOf(e: Memory): Date | null {
  const s = typeof e.attributes?.start === "string" ? e.attributes.start : e.observedAt;
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function timeOf(e: Memory, timeZone: string, locale?: string): string {
  const s = startOf(e);
  if (!s) return "";
  if (e.attributes?.allDay === true) return "all day";
  const t = s.toLocaleTimeString(locale ?? "en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
  const end = typeof e.attributes?.end === "string" ? new Date(e.attributes.end) : null;
  return end && !Number.isNaN(end.getTime()) ? `${t}–${end.toLocaleTimeString(locale ?? "en-GB", { timeZone, hour: "2-digit", minute: "2-digit" })}` : t;
}

function dayOf(e: Memory, timeZone: string, locale?: string): string {
  const s = startOf(e);
  return s ? s.toLocaleDateString(locale ?? "en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }) : "";
}

/** "with Anna Rossi and Bob" — the people the meeting links to, by name, in the order linked. */
export function withPeople(e: Memory, people: Memory[]): string {
  const byId = new Map(people.map((p) => [p.id, p]));
  const names = (e.links ?? []).filter((l) => l.relation === "with").map((l) => byId.get(l.to)?.title).filter((n): n is string => !!n);
  if (names.length === 0) return "";
  if (names.length === 1) return ` with ${names[0]}`;
  if (names.length <= 4) return ` with ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return ` with ${names.slice(0, 3).join(", ")} and ${names.length - 3} others`;
}

function placeOf(e: Memory): string {
  const loc = e.attributes?.location;
  if (typeof loc !== "string" || !loc.trim()) return "";
  // The first clause of an address is the place; the rest is for the map.
  const first = loc.split(",")[0]?.trim() ?? loc;
  return ` (${first.length > 40 ? `${first.slice(0, 39)}…` : first})`;
}

export function writeBrief(input: BriefInput): Brief {
  const now = new Date(input.now);
  const today = dayKey(now, input.timeZone, input.locale);
  const greeting = greetingFor(now, input.timeZone);
  const dated = input.events.map((e) => ({ e, start: startOf(e) })).filter((x): x is { e: Memory; start: Date } => x.start !== null).sort((a, b) => a.start.getTime() - b.start.getTime());
  const lines: BriefLine[] = [];
  const used = new Set<string>();
  for (const { e, start } of dated) {
    const key = dayKey(start, input.timeZone, input.locale);
    const people = withPeople(e, input.people);
    for (const l of e.links ?? []) if (l.relation === "with" && input.people.some((p) => p.id === l.to)) used.add(l.to);
    used.add(e.id);
    if (key === today) {
      lines.push({ section: "Today", text: `${timeOf(e, input.timeZone, input.locale)} — ${e.title}${people}${placeOf(e)}.`, memoryId: e.id });
    } else if (start.getTime() > now.getTime()) {
      lines.push({ section: "Coming up", text: `${dayOf(e, input.timeZone, input.locale)}, ${timeOf(e, input.timeZone, input.locale)} — ${e.title}${people}${placeOf(e)}.`, memoryId: e.id });
    } else {
      lines.push({ section: "Recently", text: `${dayOf(e, input.timeZone, input.locale)} — ${e.title}${people}${placeOf(e)}.`, memoryId: e.id });
    }
  }
  const order = ["Today", "Coming up", "Recently"];
  lines.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
  const paragraphs: string[] = [greeting + "."];
  if (lines.length === 0) {
    paragraphs.push("Nothing on your calendar in the week around today, as far as your memory knows. A quiet stretch — or a calendar not yet connected in MemoryPoppy.");
  } else {
    if (!lines.some((l) => l.section === "Today")) paragraphs.push("Nothing on your calendar today.");
    for (const section of order) {
      const own = lines.filter((l) => l.section === section);
      if (own.length === 0) continue;
      paragraphs.push(`${section}:\n${own.map((l) => `• ${l.text}`).join("\n")}`);
    }
  }
  return { greeting, lines, text: paragraphs.join("\n\n"), memoryIds: [...used] };
}
