// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The model, on Vertex AI inside the poppy's own project (DESIGN.md §18, G2 — the Google twin of
 * §6's "Bedrock-first, IAM auth, tokens on the user's bill"). One call shape: generateContent on
 * a publisher model, with the project's own token, over REST — no SDK. The reply carries the
 * token counts, which are the meter's only source of truth (§7b: our own counters, never a
 * price list we do not hold). G3c adds the conversation with tools: the model may ask for a
 * function by name, and the trusted dispatcher — never this file — decides and executes.
 */
import { type FetchLike, GoogleError, type ProjectTokenProvider, googleJson } from "./google";

export const DEFAULT_MODEL = "gemini-2.5-flash";
/** The words on the receipt and the page. */
export const MODEL_WORDS = "Gemini 2.5 Flash on Vertex AI";
/** Vertex AI's global endpoint serves the Gemini models from wherever has room; one region can be pinned instead. */
export const DEFAULT_LOCATION = "global";
/** The thinking a model gets on the retry after a garbled tool call — enough to write the call properly, counted as output. */
export const THINKING_BUDGET_FOR_TOOLS = 1024;

/** The model's words for a message, by id. */
function wordsFor(model: string): string {
  if (model.includes("flash-lite")) return "Gemini 2.5 Flash-Lite on Vertex AI";
  if (model.includes("pro")) return "Gemini 2.5 Pro on Vertex AI";
  return MODEL_WORDS;
}

export interface ModelReply {
  text: string;
  promptTokens: number;
  outputTokens: number;
  model: string;
}

/** One function declaration, in Vertex AI's shape (the tool catalogue writes them). */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One function the model asked for — untrusted, unvalidated, possibly hostile until the dispatcher looks. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ConverseRequest {
  system: string;
  /** The conversation so far, in the model's own shape — the loop keeps it and replays it verbatim. */
  contents: unknown[];
  tools: FunctionDeclaration[];
  maxOutputTokens: number;
  model?: string;
}

export interface ConverseReply {
  text: string;
  calls: ToolCall[];
  /** The model's parts, verbatim — replayed as its turn, thought signatures and all. */
  parts: unknown[];
  promptTokens: number;
  outputTokens: number;
  model: string;
  /** The model stopped because it ran out of room, not because it had finished. */
  truncated: boolean;
}

export interface Model {
  readonly name: string;
  readonly words: string;
  /** `model` overrides the default model id for this one call — the Planner's tier (G3). */
  generate(system: string, user: string, maxOutputTokens: number, model?: string): Promise<ModelReply>;
  /** One turn of a conversation that may call tools (G3c). */
  converse(req: ConverseRequest): Promise<ConverseReply>;
}

export interface VertexModelOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  model?: string;
  location?: string;
}

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  thoughtSignature?: string;
}
interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
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

  private url(projectId: string, model = this.name): string {
    const host = this.location === "global" ? "aiplatform.googleapis.com" : `${this.location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${this.location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
  }

  async generate(system: string, user: string, maxOutputTokens: number, model = this.name): Promise<ModelReply> {
    const res = await this.post(model, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens, temperature: 0.4 },
    });
    const text = textOf(res);
    if (!text) throw new Error(`${MODEL_WORDS} answered without words${finishOf(res)}`);
    return { text, ...usageOf(res), model };
  }

  async converse(req: ConverseRequest): Promise<ConverseReply> {
    const model = req.model ?? this.name;
    const body = (thinking: boolean): unknown => ({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.contents,
      ...(req.tools.length > 0 ? { tools: [{ functionDeclarations: req.tools }], toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
      generationConfig: { maxOutputTokens: req.maxOutputTokens, temperature: 0.4, ...(thinking ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET_FOR_TOOLS } } : {}) },
    });
    let res = await this.post(model, body(false));
    // 🪤 LIVE (2026-09-08): Flash-Lite, thinking off, wrote a tool call the API could not parse —
    // MALFORMED_FUNCTION_CALL, no words, no call. One retry with a little thinking settles it; a
    // second failure is said plainly rather than retried into the caps.
    if (res.candidates?.[0]?.finishReason === "MALFORMED_FUNCTION_CALL" && req.tools.length > 0) {
      res = await this.post(model, body(true));
      if (res.candidates?.[0]?.finishReason === "MALFORMED_FUNCTION_CALL") throw new Error(`${wordsFor(model)} garbled a tool call twice (MALFORMED_FUNCTION_CALL) — try again, or pick the standard model for this job.`);
    }
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const calls: ToolCall[] = parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall?.name ?? "", args: p.functionCall?.args ?? {} }));
    const text = textOf(res);
    const truncated = res.candidates?.[0]?.finishReason === "MAX_TOKENS";
    if (!text && calls.length === 0 && !truncated) throw new Error(`${MODEL_WORDS} answered without words${finishOf(res)}`);
    return { text, calls, parts, ...usageOf(res), model, truncated };
  }

  /**
   * One request, with the lesson of the store's first Firestore call: a permission just granted
   * takes Google up to a minute to reach Vertex AI, so one 403 "permission denied" is retried
   * once, after a pause. Everything else is explained in the user's words and thrown.
   */
  private async post(model: string, body: unknown): Promise<GenerateResponse> {
    try {
      return await this.once(model, body);
    } catch (e) {
      if (!(e instanceof GoogleError && e.status === 403 && /denied on resource/i.test(e.message))) throw new Error(explainModelError(e));
      await (this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(20_000);
      try {
        return await this.once(model, body);
      } catch (again) {
        throw new Error(explainModelError(again));
      }
    }
  }

  private async once(model: string, body: unknown): Promise<GenerateResponse> {
    const t = await this.token();
    try {
      return await googleJson<GenerateResponse>(this.url(t.projectId, model), { method: "POST", token: t.accessToken, body }, { fetch: this.opts.fetch, sleep: this.opts.sleep, timeoutMs: 90_000, tries: 2 });
    } catch (e) {
      if (e instanceof GoogleError) throw e;
      throw new Error(explainModelError(e));
    }
  }
}

function textOf(res: GenerateResponse): string {
  return (res.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}
function finishOf(res: GenerateResponse): string {
  const reason = res.candidates?.[0]?.finishReason;
  return reason ? ` (${reason})` : "";
}
/** Thinking tokens are output tokens on the bill, so they are output tokens on the meter. */
function usageOf(res: GenerateResponse): { promptTokens: number; outputTokens: number } {
  return { promptTokens: res.usageMetadata?.promptTokenCount ?? 0, outputTokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0) };
}

/** Google's refusal in the user's words — what happened, and what to do. */
export function explainModelError(e: unknown): string {
  if (e instanceof GoogleError) {
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(e.message)) return "Vertex AI is not switched on in CrewPoppy's project yet — the next mint switches it on; try again in a minute.";
    if (/billing/i.test(e.message)) return "Vertex AI needs a billing account on CrewPoppy's project — pick the card on your Google Cloud connection, then try again.";
    if (e.status === 403 && /denied on resource/i.test(e.message)) return "Vertex AI has not received CrewPoppy's permission yet — Google takes up to a minute after the first approval. Try again shortly.";
    if (e.status === 403) return `Vertex AI refused: ${e.message}`;
    if (e.status === 429) return "Vertex AI is busy — try again in a moment.";
    return `Vertex AI answered ${e.status}: ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
