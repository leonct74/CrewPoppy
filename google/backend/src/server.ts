// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * CrewPoppy's Google Cloud edition — the backend AgentsPoppy spawns for this connection, on its
 * own node22, confined. Its own records live in Firestore inside the poppy's own project; the
 * memories it reads come through the host's memory route, never from a store of its own. This
 * release has one crew member, the Briefer, with a pen on Vertex AI (DESIGN.md §18, G1 + G2).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryClient } from "@agentspoppy/client";
import { readBootstrap } from "./bootstrap";
import { RestFirestore } from "./firestore";
import { createProjectTokenProvider } from "./google";
import { type MemoryReader, type Reply, handle } from "./routes";
import { CrewStore } from "./store";
import { VertexModel } from "./vertex";

const boot = readBootstrap();
const log = (line: string): void => console.log(`[crewpoppy-google] ${line}`);
const now = (): string => new Date().toISOString();

const onGoogle = boot.account.cloud === "gcp" && !!boot.credentialsUrl;
const projectToken = createProjectTokenProvider(boot);
const store = new CrewStore({ wire: new RestFirestore(projectToken, { log }), now, log });
// The pen: Gemini on Vertex AI inside the poppy's own project (G2). The same token, the same wall.
const model = onGoogle ? new VertexModel(projectToken) : null;
if (!onGoogle) log("no Google Cloud connection in the bootstrap — the store cannot open (a bare run)");
const memory: MemoryReader | null = boot.memoryUrl ? (createMemoryClient(boot) as unknown as MemoryReader) : null;
if (!memory) log("no memoryUrl in the bootstrap — the manifest must declare permissionSet.memory.reads");

function send(res: import("node:http").ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(reply.body));
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body: unknown;
    try {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return send(res, { status: 400, body: { ok: false, error: "bad_json", message: "body is not JSON" } });
    }
    handle(url.pathname, req.method ?? "GET", body, { store, memory, model, now, log }).then(
      (r) => send(res, r),
      (e) => send(res, { status: 500, body: { ok: false, error: "internal", message: e instanceof Error ? e.message : String(e) } }),
    );
  });
});

server.listen(boot.port ?? 0, "127.0.0.1", () => {
  const addr = server.address() as AddressInfo;
  log(`backend listening on 127.0.0.1:${addr.port}`);
  if (onGoogle) void store.open();
});
