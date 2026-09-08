// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { FetchLike } from "./google";
import { MODEL_WORDS, VertexModel, explainModelError } from "./vertex";
import { GoogleError } from "./google";

const token = async () => ({ accessToken: "ya29.crew", projectId: "poppy-com-crewpoppy-cl-033c81", serviceAccount: "agentspoppy@poppy-com-crewpoppy-cl-033c81.iam.gserviceaccount.com", expiration: "2099-01-01T00:00:00Z" });

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
    expect(g.calls[0]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/poppy-com-crewpoppy-cl-033c81/locations/global/publishers/google/models/gemini-2.5-flash:generateContent");
    expect(g.calls[0]!.auth).toBe("Bearer ya29.crew");
    expect(g.calls[0]!.body).toEqual({
      systemInstruction: { parts: [{ text: "Be brief." }] },
      contents: [{ role: "user", parts: [{ text: "MATERIAL:\nGood morning." }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.4 },
    });
    expect(m.words).toBe(MODEL_WORDS);
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
