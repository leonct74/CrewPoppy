// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The host's memory route as the crew calls it — the client's shape, so a test can hand in a
 * fake. Every call names its purpose in the user's words and says where the memories go next
 * (memory-contract §7); the host narrows it to our grant and writes the receipt.
 */
import type { MemoryAvailability, MemoryPage } from "@agentspoppy/core";

/** Where the memories go next, for the receipt ("to Gemini 2.5 Flash on Vertex AI, about $0.02"). */
export interface ReceiptHints {
  model?: string;
  estimatedCost?: string;
}

export interface MemoryReader {
  status(): Promise<MemoryAvailability>;
  search(req: { purpose: string; kinds?: Array<"event" | "person">; query?: string; since?: string; until?: string; limit: number; budget?: number } & ReceiptHints): Promise<MemoryPage>;
  get(req: { purpose: string; ids: string[] } & ReceiptHints): Promise<MemoryPage>;
}
