// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { AgentDef } from "./agents";
import { createIdentityTokenProvider, createMetadataTokenProvider, type FetchLike } from "./google";
import { readCloudBootstrap, runJob } from "./job";
import { scheduledRunId } from "./scheduler";
import { CrewStore, type RunRecord } from "./store";
import { FakeWire, scriptedModel } from "./testing";

const NOW = "2026-09-08T07:31:00.000Z";
const nico: AgentDef = { id: "nico", name: "Nico", role: "Note writer", instructions: "Write the day's note.", tier: "light", memory: false, capUsd: 2, tools: [], schedule: { every: "day", at: "09:00", timeZone: "Europe/Rome" }, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
const emma: AgentDef = { ...nico, id: "emma", name: "Emma", memory: true };

describe("job mode", () => {
  it("reads the host's cloud bootstrap from the environment, or nothing", () => {
    expect(readCloudBootstrap({})).toBeNull();
    expect(readCloudBootstrap({ AGENTSPOPPY_CLOUD_BOOTSTRAP: JSON.stringify({ connectionId: "c1", appId: "com.crewpoppy.cloud.google", timeZone: "Europe/Rome", memoryDoor: { url: "https://door" } }) })).toEqual({ connectionId: "c1", appId: "com.crewpoppy.cloud.google", timeZone: "Europe/Rome", memoryDoor: { url: "https://door" } });
    expect(() => readCloudBootstrap({ AGENTSPOPPY_CLOUD_BOOTSTRAP: "{}" })).toThrow(/connectionId and appId/);
  });

  it("gets the poppy's identity from Google's metadata server — the process IS the service account", async () => {
    const asked: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      asked.push(url);
      expect((init?.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");
      if (url.endsWith("/token")) return new Response(JSON.stringify({ access_token: "ya29.meta", expires_in: 3599 }));
      if (url.endsWith("/project-id")) return new Response("poppy-com-crewpoppy-cl-033c81\n");
      if (url.endsWith("/email")) return new Response("agentspoppy@poppy-com-crewpoppy-cl-033c81.iam.gserviceaccount.com");
      if (url.includes("/identity?")) return new Response(`h.${Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url")}.s`);
      return new Response("nope", { status: 404 });
    };
    let t = 1_700_000_000_000;
    const token = createMetadataTokenProvider(fetchFn, () => t);
    expect(await token()).toEqual({ accessToken: "ya29.meta", projectId: "poppy-com-crewpoppy-cl-033c81", serviceAccount: "agentspoppy@poppy-com-crewpoppy-cl-033c81.iam.gserviceaccount.com", expiration: new Date(t + 3599 * 1000).toISOString() });
    await token();
    expect(asked.filter((u) => u.endsWith("/token"))).toHaveLength(1);
    const identity = createIdentityTokenProvider(fetchFn, () => t);
    expect(await identity("https://door")).toMatch(/^h\./);
    await identity("https://door");
    expect(asked.filter((u) => u.includes("/identity?audience=https%3A%2F%2Fdoor&format=full"))).toHaveLength(1);
  });

  it("runs the due slots once with the same ids as at home, leaves memory agents to the app when there is no door, and exits", async () => {
    const wire = new FakeWire();
    const store = new CrewStore({ wire, now: () => NOW, timeZone: () => "Europe/Rome" });
    await store.saveAgent(nico).catch(() => {});
    const model = scriptedModel([{ text: "Today's note." }]);
    const logged: string[] = [];
    const deps = { store, memory: null, model, now: () => NOW, timeZone: () => "Europe/Rome", via: "cloud" as const, log: (l: string) => logged.push(l) };
    const report = await runJob(deps);
    expect(report).toMatchObject({ ran: [], skipped: [] }); // the store had no agents saved before it opened — save after open:
    await store.saveAgent(nico);
    await store.saveAgent(emma);
    const second = await runJob(deps);
    expect(second.ran).toEqual(["Nico (2026-09-08T0900)"]);
    expect(second.skipped).toEqual(["Emma: needs CrewPoppy open — your memory is reachable only through AgentsPoppy"]);
    const run = wire.col("runs").get(scheduledRunId("nico", "2026-09-08T0900")) as RunRecord;
    expect(run).toMatchObject({ status: "succeeded", trigger: "schedule", via: "cloud", answer: "Today's note." });
    const left = wire.col("runs").get(scheduledRunId("emma", "2026-09-08T0900")) as RunRecord;
    expect(left).toMatchObject({ status: "stopped", trigger: "schedule", via: "cloud", note: "Emma did not run here: needs CrewPoppy open — your memory is reachable only through AgentsPoppy." });
    // The next pass finds both slots recorded and runs nothing.
    expect(await runJob(deps)).toMatchObject({ ran: [], skipped: [] });
    expect(logged.at(-1)).toMatch(/^job: ran 0/);
  });
});
