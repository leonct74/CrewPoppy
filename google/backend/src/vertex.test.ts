// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { FetchLike } from "./google";
import { MODEL_WORDS, VertexModel, explainModelError } from "./vertex";
import { GoogleError } from "./google";

const token = async () => ({ accessToken: "ya29.crew", projectId: "poppy-com-crewpoppy-cl-abc123", serviceAccount: "agentspoppy@poppy-com-crewpoppy-cl-abc123.iam.gserviceaccount.com", expiration: "2099-01-01T00:00:00Z" });

function google(answers: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.authorization });
    const a = answers.shift()!;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("the model on Vertex AI", () => {
  it("asks generateContent on the poppy's own project with the project token, and reports the tokens", async () => {
    const g = google([{ status: 200, body: { candidates: [{ content: { parts: [{ text: "Good morning. " }, { text: "Nothing today." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 9 } } }]);
    const m = new VertexModel(token, { fetch: g.fetch, sleep: async () => {} });
    const r = await m.generate("Be brief.", "MATERIAL:\nGood morning.", 400);
    expect(r).toEqual({ text: "Good morning. Nothing today.", promptTokens: 120, outputTokens: 9, model: "gemini-2.5-flash" });
    expect(g.calls[0]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/poppy-com-crewpoppy-cl-abc123/locations/global/publishers/google/models/gemini-2.5-flash:generateContent");
    expect(g.calls[0]!.auth).toBe("Bearer ya29.crew");
    expect(g.calls[0]!.body).toEqual({
      systemInstruction: { parts: [{ text: "Be brief." }] },
      contents: [{ role: "user", parts: [{ text: "MATERIAL:\nGood morning." }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.4 },
    });
    expect(m.words).toBe(MODEL_WORDS);
  });

  it("retries once, after a pause, when a freshly granted permission has not reached Vertex AI yet", async () => {
    const denied = { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission 'aiplatform.endpoints.predict' denied on resource '//aiplatform.googleapis.com/projects/p/locations/global/publishers/google/models/gemini-2.5-flash' (or it may not exist)." } } };
    const ok = { status: 200, body: { candidates: [{ content: { parts: [{ text: "Good morning." }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } } };
    const slept: number[] = [];
    const g = google([denied, ok]);
    const m = new VertexModel(token, { fetch: g.fetch, sleep: async (ms) => { slept.push(ms); } });
    expect((await m.generate("s", "u", 50)).text).toBe("Good morning.");
    expect(g.calls).toHaveLength(2);
    expect(slept).toContain(20_000);
    const g2 = google([denied, denied]);
    await expect(new VertexModel(token, { fetch: g2.fetch, sleep: async () => {} }).generate("s", "u", 50)).rejects.toThrow(/has not received CrewPoppy's permission yet/);
  });

  it("converses with tools: the declarations go in the request, a function call comes back with the model's parts to replay, and thinking tokens count as output", async () => {
    const g = google([
      { status: 200, body: { candidates: [{ content: { parts: [{ text: "Let me look. " }, { functionCall: { name: "memory_search", args: { query: "Anna" } }, thoughtSignature: "sig-1" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12, thoughtsTokenCount: 30 } } },
      { status: 200, body: { candidates: [{ content: { parts: [{ text: "Half an ans" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 50 } } },
    ]);
    const m = new VertexModel(token, { fetch: g.fetch, sleep: async () => {} });
    const tools = [{ name: "memory_search", description: "Search.", parameters: { type: "OBJECT", properties: { query: { type: "STRING", description: "words" } }, required: ["query"] } }];
    const r = await m.converse({ system: "Be Emma.", contents: [{ role: "user", parts: [{ text: "Who is Anna?" }] }], tools, maxOutputTokens: 300, model: "gemini-2.5-flash-lite" });
    expect(r).toEqual({ text: "Let me look.", calls: [{ name: "memory_search", args: { query: "Anna" } }], parts: [{ text: "Let me look. " }, { functionCall: { name: "memory_search", args: { query: "Anna" } }, thoughtSignature: "sig-1" }], promptTokens: 90, outputTokens: 42, model: "gemini-2.5-flash-lite", truncated: false });
    expect(g.calls[0]!.url).toContain("/models/gemini-2.5-flash-lite:generateContent");
    expect(g.calls[0]!.body).toMatchObject({ tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: "AUTO" } }, generationConfig: { maxOutputTokens: 300 } });
    const cut = await m.converse({ system: "s", contents: [{ role: "user", parts: [{ text: "u" }] }], tools: [], maxOutputTokens: 5 });
    expect(cut).toMatchObject({ text: "Half an ans", calls: [], truncated: true, outputTokens: 50 });
    expect(g.calls[1]!.body).not.toHaveProperty("tools");
  });

  it("retries a garbled tool call once with thinking on, and says so plainly the second time", async () => {
    const garbled = { status: 200, body: { candidates: [{ content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 0 } } };
    const fine = { status: 200, body: { candidates: [{ content: { parts: [{ functionCall: { name: "ask_user", args: { question: "Who?" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 8, thoughtsTokenCount: 40 } } };
    const g = google([garbled, fine]);
    const m = new VertexModel(token, { fetch: g.fetch, sleep: async () => {} });
    const tools = [{ name: "ask_user", description: "Ask.", parameters: { type: "OBJECT", properties: { question: { type: "STRING", description: "q" } }, required: ["question"] } }];
    const r = await m.converse({ system: "s", contents: [{ role: "user", parts: [{ text: "u" }] }], tools, maxOutputTokens: 300, model: "gemini-2.5-flash-lite" });
    expect(r.calls).toEqual([{ name: "ask_user", args: { question: "Who?" } }]);
    expect(r.outputTokens).toBe(48);
    expect(g.calls).toHaveLength(2);
    expect((g.calls[0]!.body as { generationConfig: Record<string, unknown> }).generationConfig).not.toHaveProperty("thinkingConfig");
    expect((g.calls[1]!.body as { generationConfig: { thinkingConfig: unknown } }).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024 });
    const g2 = google([garbled, garbled]);
    await expect(new VertexModel(token, { fetch: g2.fetch }).converse({ system: "s", contents: [], tools, maxOutputTokens: 10, model: "gemini-2.5-flash-lite" })).rejects.toThrow(/Gemini 2.5 Flash-Lite on Vertex AI garbled a tool call twice/);
  });

  it("names a pinned region's endpoint", () => {
    const m = new VertexModel(token, { location: "europe-west4", model: "gemini-2.5-pro" });
    expect((m as unknown as { url(p: string): string }).url("p1")).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/p1/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent");
  });

  it("explains a refusal in the user's words, and an empty answer", async () => {
    expect(explainModelError(new GoogleError(403, "PERMISSION_DENIED", "Vertex AI API has not been used in project 123 before or it is disabled."))).toMatch(/not switched on/);
    expect(explainModelError(new GoogleError(403, "PERMISSION_DENIED", "This API method requires billing to be enabled."))).toMatch(/billing account/);
    expect(explainModelError(new GoogleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded"))).toMatch(/busy/);
    const g = google([{ status: 200, body: { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] } }]);
    await expect(new VertexModel(token, { fetch: g.fetch }).generate("s", "u", 10)).rejects.toThrow(/answered without words \(SAFETY\)/);
  });
});
