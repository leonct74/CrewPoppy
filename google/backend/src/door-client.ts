// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The memory poppy's DOOR, as a consumer knocks on it (DESIGN.md §18 G4c; memory-poppy §14 M6):
 * the same calls as the host's memory route, over HTTPS to the provider's Cloud Run service,
 * with a Google ID token for the door's audience instead of the host's bearer. The door derives
 * the caller from the token, narrows with the host's own rules, and writes the receipt the host
 * collects at the next open. This client sends the request and nothing else: no credential of
 * its own, no schema of the provider's.
 */
import type { MemoryAvailability, MemoryPage } from "@agentspoppy/core";
import type { FetchLike, IdentityTokenProvider } from "./google";
import type { MemoryReader } from "./memory-reader";

export interface DoorAddress {
  /** The door service's URL — also the token's audience unless one is given. */
  url: string;
  audience?: string;
}

export function createDoorMemoryClient(door: DoorAddress, identity: IdentityTokenProvider, fetchFn: FetchLike = fetch): MemoryReader {
  const base = door.url.replace(/\/+$/, "");
  const audience = door.audience ?? base;
  async function call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const token = await identity(audience);
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    let parsed: unknown = {};
    try {
      parsed = await res.json();
    } catch {
      /* reported below */
    }
    if (!res.ok) {
      const e = (parsed ?? {}) as { error?: string; message?: string };
      throw new Error(`the memory door refused (${res.status}): ${e.message ?? e.error ?? "no reason given"}`);
    }
    return parsed as T;
  }
  return {
    status: () => call<MemoryAvailability>("/memory/status", "GET"),
    search: (req) => call<MemoryPage>("/memory/search", "POST", req),
    get: (req) => call<MemoryPage>("/memory/get", "POST", req),
  };
}
