import { describe, expect, it, vi } from "vitest";
import { runLoop, type LoopDeps, type ModelReply } from "./loop";
import { DEFAULT_CAPS, type AgentDef } from "@crewpoppy/shared";
import type { ToolResult } from "./dispatcher";

const agent: AgentDef = {
  id: "a1",
  name: "Emma",
  role: "Assistant",
  instructions: "Be brief.",
  modelId: "qwen.qwen3-32b-v1:0",
  tools: ["memory_read", "memory_write", "ask_user"],
  caps: DEFAULT_CAPS,
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

const reply = (over: Partial<ModelReply> = {}): ModelReply => ({
  text: "",
  toolUses: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  raw: [],
  ...over,
});

function deps(over: Partial<LoopDeps> & { replies?: ModelReply[]; results?: ToolResult[] } = {}) {
  const replies = over.replies ?? [reply({ text: "Done." })];
  const results = over.results ?? [];
  const recorded: { role: string; text: string }[] = [];
  const sent: unknown[] = [];
  const dispatched: { name: string; input: unknown }[] = [];
  let ri = 0;
  let si = 0;
  const d: LoopDeps = {
    callModel: vi.fn(async (args) => {
      sent.push(args);
      return replies[Math.min(ri++, replies.length - 1)]!;
    }),
    dispatch: vi.fn(async (name, input) => {
      dispatched.push({ name, input });
      return results[Math.min(si++, results.length - 1)] ?? { content: "ok" };
    }),
    record: vi.fn(async (role, text) => {
      recorded.push({ role, text });
    }),
    isStopped: vi.fn(async () => false),
    now: () => 1_000,
    ...over,
  };
  return { d, recorded, sent, dispatched };
}

describe("a run with no tool calls", () => {
  it("answers and stops after one turn", async () => {
    const { d, sent } = deps({ replies: [reply({ text: "Here you go." })] });
    const out = await runLoop(agent, "sys", "Summarise this.", 0, 0, d);
    expect(out.status).toBe("succeeded");
    expect(out.output).toBe("Here you go.");
    expect(out.iterations).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("offers the model only the tools this agent has", async () => {
    const { d, sent } = deps();
    await runLoop({ ...agent, tools: ["memory_read"] }, "sys", "hi", 0, 0, d);
    const names = (sent[0] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(["memory_read"]);
  });

  it("offers no tools at all to an agent with none", async () => {
    const { d, sent } = deps();
    await runLoop({ ...agent, tools: [] }, "sys", "hi", 0, 0, d);
    expect((sent[0] as { tools: unknown[] }).tools).toEqual([]);
  });
});

describe("tool calls round-trip as data", () => {
  it("dispatches the tool, feeds the result back, and finishes", async () => {
    const { d, dispatched, sent } = deps({
      replies: [
        reply({ toolUses: [{ id: "t1", name: "memory_read", input: { key: "voice" } }], raw: [{ type: "tool_use" }] }),
        reply({ text: "Your voice is warm." }),
      ],
      results: [{ content: "warm and brief" }],
    });
    const out = await runLoop(agent, "sys", "What's my voice?", 0, 0, d);

    expect(out.status).toBe("succeeded");
    expect(dispatched).toEqual([{ name: "memory_read", input: { key: "voice" } }]);
    // The second request carries the assistant turn and the tool RESULT as content.
    const second = (sent[1] as { messages: any[] }).messages;
    expect(second[1].role).toBe("assistant");
    expect(second[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "warm and brief" });
    expect(out.iterations).toBe(2);
  });

  it("marks a failed tool as an error result rather than ending the run", async () => {
    const { d, sent } = deps({
      replies: [
        reply({ toolUses: [{ id: "t1", name: "workspace_read", input: { path: "../x" } }] }),
        reply({ text: "I couldn't read that." }),
      ],
      results: [{ content: "That file name isn't allowed.", isError: true }],
    });
    const out = await runLoop(agent, "sys", "read it", 0, 0, d);
    const second = (sent[1] as { messages: any[] }).messages;
    expect(second[2].content[0].is_error).toBe(true);
    expect(out.status).toBe("succeeded"); // the model recovered
  });

  it("records every tool call in the visible transcript (DESIGN §9)", async () => {
    const { d, recorded } = deps({
      replies: [reply({ toolUses: [{ id: "t1", name: "memory_write", input: { key: "k", value: "v" } }] }), reply({ text: "Saved." })],
      results: [{ content: "Remembered under \"k\"." }],
    });
    await runLoop(agent, "sys", "remember v", 0, 0, d);
    const tools = recorded.filter((r) => r.role === "tool");
    expect(tools[0]!.text).toContain("memory_write");
    expect(tools.some((t) => t.text.includes("Remembered"))).toBe(true);
  });
});

describe("guardrails stop the loop at a turn boundary (DESIGN §7)", () => {
  it("stops at the iteration cap without calling the model again", async () => {
    // A model that always asks for another tool would otherwise loop forever.
    const { d, sent } = deps({
      replies: [reply({ toolUses: [{ id: "t", name: "memory_read", input: { key: "k" } }] })],
      results: [{ content: "ok" }],
    });
    const out = await runLoop({ ...agent, caps: { ...DEFAULT_CAPS, maxIterations: 3 } }, "sys", "go", 0, 0, d);
    expect(out.status).toBe("stopped");
    expect(out.stopReason).toBe("max_iterations");
    expect(sent).toHaveLength(3); // exactly the cap, not one more
  });

  it("stops when the month's spend crosses the cap mid-run", async () => {
    // Uses an UNPRICED model on purpose: those are charged at the safety ceiling, which
    // is the path that used to accumulate nothing and leave the cap inert.
    const heavy = reply({
      toolUses: [{ id: "t", name: "memory_read", input: {} }],
      usage: { inputTokens: 5000, outputTokens: 5000 }, // well under the token cap
    });
    const { d, sent } = deps({ replies: [heavy], results: [{ content: "ok" }] });
    const out = await runLoop(
      { ...agent, modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0" },
      "sys",
      "go",
      9.9, // one turn at the ceiling rate takes this past $10
      0,
      d,
    );
    expect(out.stopReason).toBe("monthly_spend_cap");
    expect(sent).toHaveLength(1); // stopped before spending again
  });

  it("keeps the best answer so far when a limit cuts the run short", async () => {
    const { d } = deps({
      replies: [reply({ text: "Partial thought.", toolUses: [{ id: "t", name: "memory_read", input: {} }] })],
      results: [{ content: "ok" }],
    });
    const out = await runLoop({ ...agent, caps: { ...DEFAULT_CAPS, maxIterations: 1 } }, "sys", "go", 0, 0, d);
    expect(out.output).toBe("Partial thought.");
  });

  it("honours the kill switch before the next model call", async () => {
    const { d, sent } = deps({ isStopped: vi.fn(async () => true) });
    const out = await runLoop(agent, "sys", "go", 0, 0, d);
    expect(out.status).toBe("stopped");
    expect(sent).toHaveLength(0);
  });
});

describe("ask_user suspends the run (DESIGN §5)", () => {
  it("stops and hands back the whole conversation to checkpoint", async () => {
    const { d, sent } = deps({
      replies: [
        reply({
          toolUses: [{ id: "t1", name: "ask_user", input: { question: "Send it?", draft: "Dear Sam" } }],
          raw: [{ type: "tool_use", id: "t1" }],
        }),
      ],
      results: [{ content: "Asked the owner.", suspend: { question: "Send it?", draft: "Dear Sam" } }],
    });
    const out = await runLoop(agent, "sys", "draft a reply", 0, 0, d);

    expect(out.status).toBe("waiting");
    expect(out.stopReason).toBe("waiting_for_you");
    expect(out.suspend?.question).toBe("Send it?");
    expect(out.suspend?.draft).toBe("Dear Sam");
    // The model is NOT called again — a human decides next.
    expect(sent).toHaveLength(1);
  });

  it("checkpoints a conversation that can actually be resumed", async () => {
    // The suspending tool_use still needs its matching tool_result, or the stored
    // conversation is malformed and Bedrock rejects it on resume.
    const { d } = deps({
      replies: [reply({ toolUses: [{ id: "t1", name: "ask_user", input: { question: "OK?" } }], raw: [{ type: "tool_use", id: "t1" }] })],
      results: [{ content: "Asked.", suspend: { question: "OK?" } }],
    });
    const out = await runLoop(agent, "sys", "go", 0, 0, d);
    const msgs = out.suspend!.messages as any[];
    expect(msgs[msgs.length - 1].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
  });

  it("shows the question in the transcript so it's visible in the dashboard too", async () => {
    const { d, recorded } = deps({
      replies: [reply({ toolUses: [{ id: "t1", name: "ask_user", input: { question: "Approve?" } }] })],
      results: [{ content: "Asked.", suspend: { question: "Approve?" } }],
    });
    await runLoop(agent, "sys", "go", 0, 0, d);
    expect(recorded.some((r) => r.text.includes("Waiting for you: Approve?"))).toBe(true);
  });
});
