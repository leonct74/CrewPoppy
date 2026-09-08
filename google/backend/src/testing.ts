// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/** Test doubles shared by the suites — not a test file itself. */
import type { FirestoreWire, IndexField, WireDoc, WireWrite } from "./firestore";
import type { ConverseReply, ConverseRequest, Model } from "./vertex";

/** A Firestore that lives in a Map: what the store writes must be here, or it was never kept. */
export class FakeWire implements FirestoreWire {
  readonly docs = new Map<string, Map<string, object>>();
  col(c: string): Map<string, object> {
    let m = this.docs.get(c);
    if (!m) this.docs.set(c, (m = new Map()));
    return m;
  }
  async projectId(): Promise<string> {
    return "poppy-com-crewpoppy-fake";
  }
  async ensureDatabase(region: string): Promise<{ created: boolean; locationId: string }> {
    return { created: true, locationId: region };
  }
  async ensureIndex(_c: string, _f: IndexField[]): Promise<void> {}
  async get<T>(c: string, id: string): Promise<T | null> {
    return (this.col(c).get(id) as T | undefined) ?? null;
  }
  async set(c: string, id: string, data: object): Promise<void> {
    this.col(c).set(id, structuredClone(data));
  }
  async commit(writes: WireWrite[]): Promise<void> {
    for (const w of writes) this.col(w.collection).set(w.id, structuredClone(w.data));
  }
  async listChanged<T>(c: string): Promise<WireDoc<T>[]> {
    return [...this.col(c).entries()].map(([id, data]) => ({ id, data: data as T }));
  }
  async delete(c: string, id: string): Promise<void> {
    this.col(c).delete(id);
  }
}

export type Scripted = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }>; promptTokens?: number; outputTokens?: number; truncated?: boolean };

/**
 * A model that follows a script: each conversation turn takes the next entry, in order. `generate`
 * (the Briefer, the judge) answers from `words`. Every request is recorded.
 */
export function scriptedModel(script: Scripted[], words = "ok"): Model & { requests: ConverseRequest[]; generated: Array<{ system: string; user: string; model?: string }> } {
  const requests: ConverseRequest[] = [];
  const generated: Array<{ system: string; user: string; model?: string }> = [];
  return {
    requests,
    generated,
    name: "gemini-2.5-flash",
    words: "Gemini 2.5 Flash on Vertex AI",
    async generate(system, user, _max, m) {
      generated.push({ system, user, model: m });
      return { text: words, promptTokens: 20, outputTokens: 2, model: m ?? "gemini-2.5-flash" };
    },
    async converse(req): Promise<ConverseReply> {
      requests.push(structuredClone(req));
      const s = script.shift();
      if (!s) throw new Error("the script ran out");
      const parts: unknown[] = [];
      if (s.text) parts.push({ text: s.text });
      for (const c of s.calls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      return { text: s.text ?? "", calls: s.calls ?? [], parts, promptTokens: s.promptTokens ?? 100, outputTokens: s.outputTokens ?? 20, model: req.model ?? "gemini-2.5-flash", truncated: s.truncated ?? false };
    },
  };
}

/** The last user turn's function responses, as the model would read them. */
export function responsesOf(req: ConverseRequest): Array<{ name: string; response: Record<string, unknown> }> {
  const last = req.contents[req.contents.length - 1] as { role: string; parts: Array<{ functionResponse?: { name: string; response: Record<string, unknown> } }> };
  return last.parts.flatMap((p) => (p.functionResponse ? [p.functionResponse] : []));
}
