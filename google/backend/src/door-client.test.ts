// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import { createDoorMemoryClient } from "./door-client";
import type { FetchLike } from "./google";

describe("knocking on the memory door", () => {
  it("sends the same request as at home, with an ID token for the door's audience, and reads the page back", async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>).authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ memories: [], truncated: false, receipt: "door-rcpt-1" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const asked: string[] = [];
    const client = createDoorMemoryClient({ url: "https://memory-door-abc.a.run.app/" }, async (aud) => { asked.push(aud); return "id.token.for.door"; }, fetchFn);
    const page = await client.search({ purpose: 'Nico: "the note"', query: "Tom", limit: 12, model: "Gemini 2.5 Flash-Lite on Vertex AI" });
    expect(page.receipt).toBe("door-rcpt-1");
    expect(asked).toEqual(["https://memory-door-abc.a.run.app"]);
    expect(calls[0]).toEqual({ url: "https://memory-door-abc.a.run.app/memory/search", auth: "Bearer id.token.for.door", body: { purpose: 'Nico: "the note"', query: "Tom", limit: 12, model: "Gemini 2.5 Flash-Lite on Vertex AI" } });
  });

  it("says plainly when the door refuses", async () => {
    const fetchFn: FetchLike = async () => new Response(JSON.stringify({ error: "door_forbidden", message: "CrewPoppy is not allowed through this door" }), { status: 403 });
    const client = createDoorMemoryClient({ url: "https://door", audience: "aud-1" }, async () => "t", fetchFn);
    await expect(client.status()).rejects.toThrow("the memory door refused (403): CrewPoppy is not allowed through this door");
  });
});
