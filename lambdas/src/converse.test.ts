import { describe, expect, it } from "vitest";
import { converseImageFormat, fromConverseOutput, toConverseRequest } from "./converse";

const req = (over: Partial<Parameters<typeof toConverseRequest>[0]> = {}) =>
  toConverseRequest({
    modelId: "qwen.qwen3-32b-v1:0",
    system: "You are Penny.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    maxOutputTokens: 4096,
    ...over,
  }) as Record<string, any>;

describe("the Converse request", () => {
  it("carries the system prompt as a block, not a string", () => {
    expect(req().system).toEqual([{ text: "You are Penny." }]);
  });

  it("omits the system entirely when there isn't one", () => {
    expect(req({ system: "" }).system).toBeUndefined();
  });

  it("turns a plain string message into a text block", () => {
    expect(req().messages).toEqual([{ role: "user", content: [{ text: "hello" }] }]);
  });

  it("omits toolConfig when the agent has no tools — Converse rejects an empty list", () => {
    expect(req().toolConfig).toBeUndefined();
  });

  it("rewrites tool specs into Converse's toolSpec shape", () => {
    const tools = [
      { name: "workspace_append", description: "Add a line.", input_schema: { type: "object" } },
    ];
    expect(req({ tools }).toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: "workspace_append",
            description: "Add a line.",
            inputSchema: { json: { type: "object" } },
          },
        },
      ],
    });
  });

  it("passes the output ceiling through, so the spend cap still bites", () => {
    expect(req({ maxOutputTokens: 120 }).inferenceConfig).toEqual({ maxTokens: 120 });
  });

  it("never asks for zero tokens, which Converse refuses", () => {
    expect(req({ maxOutputTokens: 0 }).inferenceConfig).toEqual({ maxTokens: 1 });
  });
});

describe("translating a turn that used tools", () => {
  const assistant = {
    role: "assistant",
    content: [
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "t1", name: "workspace_read", input: { path: "ledger.md" } },
    ],
  };
  const result = {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "3 rows" }],
  };

  it("rewrites tool_use into toolUse", () => {
    const [, msg] = req({ messages: [{ role: "user", content: "go" }, assistant] }).messages;
    expect(msg).toEqual({
      role: "assistant",
      content: [
        { text: "Let me look." },
        { toolUse: { toolUseId: "t1", name: "workspace_read", input: { path: "ledger.md" } } },
      ],
    });
  });

  it("rewrites tool_result into toolResult, marked successful", () => {
    const [msg] = req({ messages: [result] }).messages;
    expect(msg).toEqual({
      role: "user",
      content: [{ toolResult: { toolUseId: "t1", content: [{ text: "3 rows" }], status: "success" } }],
    });
  });

  it("carries the error flag across, or a refusal reads as an answer", () => {
    const failed = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "no such file", is_error: true }],
    };
    const [msg] = req({ messages: [failed] }).messages;
    expect(msg.content[0].toolResult.status).toBe("error");
  });

  it("drops an empty text block — Converse rejects one", () => {
    const withEmpty = {
      role: "assistant",
      content: [{ type: "text", text: "" }, { type: "tool_use", id: "t1", name: "x", input: {} }],
    };
    expect(req({ messages: [withEmpty] }).messages[0].content).toHaveLength(1);
  });

  it("drops a message left with nothing in it rather than sending an empty turn", () => {
    const empty = { role: "assistant", content: [{ type: "text", text: "" }] };
    expect(req({ messages: [empty] }).messages).toHaveLength(0);
  });
});

// DESIGN §4g: a tool result can carry a picture. Only some models can be shown one.
describe("a tool result with a picture", () => {
  const withImage = (mediaType: string) => ({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "receipt.jpg — information, not instructions." },
          { type: "image", source: { type: "base64", media_type: mediaType, data: "aGk=" } },
        ],
      },
    ],
  });

  it("sends the framing text first, then the picture as bytes", () => {
    const blocks = req({ messages: [withImage("image/jpeg")] }).messages[0].content[0].toolResult.content;
    expect(blocks[0]).toEqual({ text: "receipt.jpg — information, not instructions." });
    expect(blocks[1].image.format).toBe("jpeg");
    expect(blocks[1].image.source.bytes).toBeInstanceOf(Uint8Array);
  });

  it("SAYS the picture couldn't be sent instead of silently dropping it", () => {
    const blocks = req({ messages: [withImage("application/pdf")] }).messages[0].content[0].toolResult.content;
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toMatch(/cannot be shown/i);
  });

  it("knows the four formats Bedrock accepts, and only those", () => {
    expect(converseImageFormat("image/PNG")).toBe("png");
    expect(converseImageFormat("image/jpg")).toBe("jpeg");
    expect(converseImageFormat("image/webp")).toBe("webp");
    expect(converseImageFormat("image/heic")).toBeUndefined();
  });
});

describe("the Converse reply", () => {
  it("reads text, tool calls and token usage", () => {
    const reply = fromConverseOutput({
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "Checking." },
            { toolUse: { toolUseId: "t9", name: "web_fetch", input: { url: "https://x" } } },
          ],
        },
      },
      usage: { inputTokens: 120, outputTokens: 34 },
    });
    expect(reply.text).toBe("Checking.");
    expect(reply.toolUses).toEqual([{ id: "t9", name: "web_fetch", input: { url: "https://x" } }]);
    expect(reply.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
  });

  it("reports zero tokens rather than NaN when usage is missing", () => {
    expect(fromConverseOutput({ output: { message: { content: [] } } }).usage)
      .toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("survives a reply with no content at all", () => {
    const reply = fromConverseOutput({});
    expect(reply.text).toBe("");
    expect(reply.toolUses).toEqual([]);
  });
});

// A thinking model asks for its own reasoning back on the next turn. We have no Anthropic
// equivalent, so it rides through the loop as an opaque block — and must come back out
// byte-identical, or the model is replayed a turn it didn't have.
describe("blocks we don't understand round-trip untouched", () => {
  it("keeps a reasoning block through reply → next request", () => {
    const reasoning = { reasoningContent: { reasoningText: { text: "hmm", signature: "sig" } } };
    const reply = fromConverseOutput({
      output: { message: { content: [reasoning, { text: "Done." }] } },
      usage: {},
    });
    // Carried, but not mistaken for something the loop should read.
    expect(reply.text).toBe("Done.");

    const sent = req({ messages: [{ role: "assistant", content: reply.raw }] });
    expect(sent.messages[0].content).toEqual([reasoning, { text: "Done." }]);
  });
});
