// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The model, on Vertex AI inside the poppy's own project (DESIGN.md §18, G2 — the Google twin of
 * §6's "Bedrock-first, IAM auth, tokens on the user's bill"). One call shape: generateContent on
 * a publisher model, with the project's own token, over REST — no SDK. The reply carries the
 * token counts, which are the meter's only source of truth (§7b: our own counters, never a
 * price list we do not hold).
 */
import { type FetchLike, GoogleError, type ProjectTokenProvider, googleJson } from "./google";

export const DEFAULT_MODEL = "gemini-2.5-flash";
/** The words on the receipt and the page. */
export const MODEL_WORDS = "Gemini 2.5 Flash on Vertex AI";
/** Vertex AI's global endpoint serves the Gemini models from wherever has room; one region can be pinned instead. */
export const DEFAULT_LOCATION = "global";

export interface ModelReply {
  text: string;
  promptTokens: number;
  outputTokens: number;
  model: string;
}

export interface Model {
  readonly name: string;
  readonly words: string;
  generate(system: string, user: string, maxOutputTokens: number): Promise<ModelReply>;
}

export interface VertexModelOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  model?: string;
  location?: string;
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

export class VertexModel implements Model {
  readonly name: string;
  readonly words = MODEL_WORDS;
  private readonly location: string;

  constructor(
    private readonly token: ProjectTokenProvider,
    private readonly opts: VertexModelOptions = {},
  ) {
    this.name = opts.model ?? DEFAULT_MODEL;
    this.location = opts.location ?? DEFAULT_LOCATION;
  }

  private url(projectId: string): string {
    const host = this.location === "global" ? "aiplatform.googleapis.com" : `${this.location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${this.location}/publishers/google/models/${encodeURIComponent(this.name)}:generateContent`;
  }

  async generate(system: string, user: string, maxOutputTokens: number): Promise<ModelReply> {
    const t = await this.token();
    let res: GenerateResponse;
    try {
      res = await googleJson<GenerateResponse>(
        this.url(t.projectId),
        {
          method: "POST",
          token: t.accessToken,
          body: {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens, temperature: 0.4 },
          },
        },
        { fetch: this.opts.fetch, sleep: this.opts.sleep, timeoutMs: 60_000, tries: 2 },
      );
    } catch (e) {
      throw new Error(explainModelError(e));
    }
    const text = (res.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error(`${MODEL_WORDS} answered without words${res.candidates?.[0]?.finishReason ? ` (${res.candidates[0].finishReason})` : ""}`);
    return {
      text,
      promptTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      model: this.name,
    };
  }
}

/** Google's refusal in the user's words — what happened, and what to do. */
export function explainModelError(e: unknown): string {
  if (e instanceof GoogleError) {
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(e.message)) return "Vertex AI is not switched on in CrewPoppy's project yet — the next mint switches it on; try again in a minute.";
    if (/billing/i.test(e.message)) return "Vertex AI needs a billing account on CrewPoppy's project — pick the card on your Google Cloud connection, then try again.";
    if (e.status === 403) return `Vertex AI refused: ${e.message}`;
    if (e.status === 429) return "Vertex AI is busy — try again in a moment.";
    return `Vertex AI answered ${e.status}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
