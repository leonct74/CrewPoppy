// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { Memory } from "@agentspoppy/core";
import { greetingFor, withPeople, writeBrief } from "./briefer";

const TZ = "Europe/Rome";
const NOW = "2026-09-08T06:30:00.000Z"; // 08:30 in Rome, a Tuesday
const prov = { app: "com.agentspoppy.memory", source: "calendar" as const, capturedAt: NOW };
const person = (id: string, title: string): Memory => ({ id, kind: "person", title, provenance: prov, confidence: 0.8, createdAt: NOW, updatedAt: NOW, visibility: "shared", status: "active" });
const event = (id: string, title: string, start: string, end: string, links: string[] = [], extra: Record<string, string | boolean> = {}): Memory => ({
  id,
  kind: "event",
  title,
  attributes: { start, end, allDay: false, ...extra },
  links: links.map((to) => ({ to, relation: "with" as const })),
  provenance: prov,
  confidence: 0.9,
  observedAt: start,
  createdAt: NOW,
  updatedAt: NOW,
  visibility: "shared",
  status: "active",
});

describe("the Briefer", () => {
  it("greets by the hour where the user is", () => {
    expect(greetingFor(new Date("2026-09-08T06:30:00Z"), TZ)).toBe("Good morning");
    expect(greetingFor(new Date("2026-09-08T13:00:00Z"), TZ)).toBe("Good afternoon");
    expect(greetingFor(new Date("2026-09-08T19:00:00Z"), TZ)).toBe("Good evening");
    expect(greetingFor(new Date("2026-09-08T01:00:00Z"), TZ)).toBe("Good night");
  });

  it("names the people a meeting links to", () => {
    const anna = person("p1", "Anna Rossi");
    const bob = person("p2", "Bob");
    const e = event("e1", "Board", "2026-09-08T07:00:00Z", "2026-09-08T08:30:00Z", ["p1", "p2", "p-unknown"]);
    expect(withPeople(e, [anna, bob])).toBe(" with Anna Rossi and Bob");
    expect(withPeople(event("e2", "Solo", "2026-09-08T07:00:00Z", "2026-09-08T08:00:00Z"), [anna])).toBe("");
  });

  it("writes today, coming up and recently, in the user's clock, and remembers what it drew on", () => {
    const anna = person("p1", "Anna Rossi");
    const brief = writeBrief({
      events: [
        event("e-past", "Cozy Code @ Contact Maker Space", "2026-08-30T11:00:00Z", "2026-08-30T15:00:00Z", [], { location: "CONTACT, Contactweg 47, 1014AN, Amsterdam" }),
        event("e-today", "Board meeting", "2026-09-08T07:00:00Z", "2026-09-08T08:30:00Z", ["p1"], { location: "Via Roma 1, Milano" }),
        event("e-next", "Dentist", "2026-09-10T14:00:00Z", "2026-09-10T14:30:00Z"),
      ],
      people: [anna],
      now: NOW,
      timeZone: TZ,
    });
    expect(brief.greeting).toBe("Good morning");
    expect(brief.lines.map((l) => l.section)).toEqual(["Today", "Coming up", "Recently"]);
    expect(brief.text).toBe(
      [
        "Good morning.",
        "Today:\n• 09:00–10:30 — Board meeting with Anna Rossi (Via Roma 1).",
        "Coming up:\n• Thu 10 Sept, 16:00–16:30 — Dentist.",
        "Recently:\n• Sun 30 Aug — Cozy Code @ Contact Maker Space (CONTACT).",
      ].join("\n\n"),
    );
    expect(brief.memoryIds.sort()).toEqual(["e-next", "e-past", "e-today", "p1"]);
  });

  it("says when there is nothing, and when today is empty", () => {
    expect(writeBrief({ events: [], people: [], now: NOW, timeZone: TZ }).text).toMatch(/^Good morning\.\n\nNothing on your calendar in the week around today/);
    const only = writeBrief({ events: [event("e", "Later", "2026-09-11T09:00:00Z", "2026-09-11T10:00:00Z")], people: [], now: NOW, timeZone: TZ });
    expect(only.text).toContain("Nothing on your calendar today.");
    expect(only.text).toContain("Coming up:");
  });
});
