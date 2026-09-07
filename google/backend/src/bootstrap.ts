// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * What the host hands this backend when it spawns it (AgentsPoppy's BackendBootstrap, mirrored
 * here so the bundle carries no SDK at runtime): the connection, the credential mint, the port,
 * the data directory — and, because the manifest declares memory reads, `memoryUrl`: the host's
 * door to the memory poppy, where every read is narrowed to our grant and written down.
 */
export interface Bootstrap {
  connectionId: string;
  credentialsUrl: string;
  credentialsToken?: string;
  port?: number;
  dataDir: string;
  account: { accountId: string; region: string; cloud?: "aws" | "gcp" };
  /** Present because `permissionSet.memory.reads` — the host's memory route for this connection. */
  memoryUrl?: string;
}

export function readBootstrap(): Bootstrap {
  const raw = process.env.AGENTSPOPPY_BOOTSTRAP;
  if (!raw) {
    return { connectionId: "dev", credentialsUrl: "", dataDir: process.cwd(), account: { accountId: "dev", region: "global", cloud: "gcp" } };
  }
  return JSON.parse(raw) as Bootstrap;
}
