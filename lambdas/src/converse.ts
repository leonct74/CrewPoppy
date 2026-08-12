// The Converse wire (DESIGN §2c) — how CrewPoppy talks to every model that isn't Claude.
//
// WHY A TRANSLATOR AND NOT A SECOND LOOP: the agentic loop, the dispatcher, the stored
// conversation and the resume path all speak ONE message shape — Anthropic's. That shape
// is the canonical one because it is what every agent in the field already has written
// down in DynamoDB. If a Qwen agent stored Converse-shaped messages, an owner who later
// switched that agent to Claude would resume into a conversation the Anthropic path
// cannot read. So the difference lives here, at the boundary, and nowhere else:
//
//   loop (Anthropic shape) → toConverseRequest → Bedrock → fromConverseOutput → loop
//
// NOTHING IS THROWN AWAY. A model with a thinking mode (Qwen3 has one) returns blocks we
// have no Anthropic equivalent for. Dropping them would be quietly lossy — the model asks
// for its own reasoning back on the next turn — so they are carried through the loop as
// opaque `__converse` blocks and handed back verbatim. The loop never inspects them; the
// Anthropic path never sees them.

import type { ModelReply, ToolUse } from "./loop";

/** A tool as `specsFor()` writes it — Anthropic's shape. */
interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The block type we use to carry a Converse block the loop has no name for. */
const OPAQUE = "__converse";

/**
 * Bedrock names image formats bare (`jpeg`), not as media types (`image/jpeg`), and
 * rejects anything outside its four. An unknown type returns undefined and the caller
 * sends the framing text alone — a picture the model cannot decode is worse than no
 * picture, because it answers anyway.
 */
export function converseImageFormat(mediaType: string): string | undefined {
  const m = mediaType.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpeg";
  if (m === "image/png") return "png";
  if (m === "image/gif") return "gif";
  if (m === "image/webp") return "webp";
  return undefined;
}

function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

type Block = Record<string, unknown>;

/** The content of one tool_result: a string, or text+image blocks (DESIGN §4g). */
function toolResultContent(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ text: content }] : [{ text: "(no output)" }];
  if (!Array.isArray(content)) return [{ text: String(content ?? "") }];

  const out: Block[] = [];
  for (const raw of content) {
    const b = raw as Block;
    if (b["type"] === "text" && typeof b["text"] === "string" && b["text"]) {
      out.push({ text: b["text"] as string });
    } else if (b["type"] === "image") {
      const source = b["source"] as { media_type?: string; data?: string } | undefined;
      const format = converseImageFormat(source?.media_type ?? "");
      // Silently skipping an undecodable image would leave the model answering about a
      // picture it never received. Say so instead.
      if (format && source?.data) out.push({ image: { format, source: { bytes: bytesOf(source.data) } } });
      else out.push({ text: "(a picture was attached, but this model cannot be shown it)" });
    }
  }
  return out.length ? out : [{ text: "(no output)" }];
}

/** One Anthropic-shaped content block → zero or more Converse blocks. */
function toConverseBlocks(raw: unknown): Block[] {
  const b = raw as Block;
  switch (b["type"]) {
    case "text":
      // Converse rejects an empty text block; the loop can produce one when a model
      // answers with tool calls only.
      return b["text"] ? [{ text: b["text"] as string }] : [];
    case "tool_use":
      return [{ toolUse: { toolUseId: b["id"], name: b["name"], input: b["input"] ?? {} } }];
    case "tool_result":
      return [
        {
          toolResult: {
            toolUseId: b["tool_use_id"],
            content: toolResultContent(b["content"]),
            status: b["is_error"] ? "error" : "success",
          },
        },
      ];
    case OPAQUE:
      return [b["block"] as Block];
    default:
      return [];
  }
}

function toConverseMessage(raw: unknown): Block | undefined {
  const m = raw as { role?: string; content?: unknown };
  const content = typeof m.content === "string"
    ? (m.content ? [{ text: m.content }] : [])
    : Array.isArray(m.content)
      ? m.content.flatMap(toConverseBlocks)
      : [];
  // A message with no content at all is not something Converse accepts, and it carries
  // nothing — drop it rather than send an empty turn.
  if (!content.length) return undefined;
  return { role: m.role === "assistant" ? "assistant" : "user", content };
}

/** Build the Converse request from what the loop hands `callModel`. */
export function toConverseRequest(args: {
  modelId: string;
  system: string;
  messages: unknown[];
  tools: unknown[];
  maxOutputTokens: number;
}): Record<string, unknown> {
  const tools = (args.tools as AnthropicToolSpec[]).map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.input_schema },
    },
  }));
  return {
    modelId: args.modelId,
    messages: args.messages.map(toConverseMessage).filter(Boolean),
    ...(args.system ? { system: [{ text: args.system }] } : {}),
    inferenceConfig: { maxTokens: Math.max(1, args.maxOutputTokens) },
    ...(tools.length ? { toolConfig: { tools } } : {}),
  };
}

/** The Converse reply → the loop's ModelReply, in Anthropic shape. */
export function fromConverseOutput(out: unknown): ModelReply {
  const o = out as {
    output?: { message?: { content?: Block[] } };
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  const blocks = o.output?.message?.content ?? [];
  const raw: Block[] = [];
  const toolUses: ToolUse[] = [];
  const texts: string[] = [];

  for (const b of blocks) {
    if (typeof b["text"] === "string") {
      texts.push(b["text"] as string);
      raw.push({ type: "text", text: b["text"] as string });
    } else if (b["toolUse"]) {
      const u = b["toolUse"] as { toolUseId?: string; name?: string; input?: Record<string, unknown> };
      toolUses.push({ id: u.toolUseId ?? "", name: u.name ?? "", input: u.input ?? {} });
      raw.push({ type: "tool_use", id: u.toolUseId ?? "", name: u.name ?? "", input: u.input ?? {} });
    } else {
      // Reasoning, or anything Bedrock adds later. Carried, not understood.
      raw.push({ type: OPAQUE, block: b });
    }
  }

  return {
    text: texts.join("").trim(),
    toolUses,
    raw,
    usage: {
      inputTokens: o.usage?.inputTokens ?? 0,
      outputTokens: o.usage?.outputTokens ?? 0,
    },
  };
}
