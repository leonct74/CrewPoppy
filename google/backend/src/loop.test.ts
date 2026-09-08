// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

import { describe, it, expect } from "vitest";
import type { ToolResult } from "./dispatcher";
import { CUT_SHORT, type LoopDeps, MAX_ITERATIONS, PENDING_ANSWER, answered, runLoop } from "./loop";
import { type Scripted, responsesOf, scriptedModel } from "./testing";

const NOW = "2026-09-08T10:00:00.000Z";
const TOOLS = [{ name: "note_read", description: "d", parameters: { type: "OBJECT", properties: {} } }];

function deps(script: Scripted[], over: Partial<LoopDeps> = {}) {
  const model = scriptedModel(script);
  const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
  const recorded: Array<[number, number]> = [];
  const d: LoopDeps = {
    callModel: (req) => model.converse({ system: "sys", ...req }),
    async dispatch(name, args): Promise<ToolResult> {
      dispatched.push({ name, args });
      if (name === "ask_user") return { content: "Asked.", suspend: { question: String(args.question), draft: "Dear all" } };
      if (name === "memory_search") return { content: "RESULTS…", receipt: "rcpt-9", read: { count: 2, bytes: 300 } };
      if (name === "boom") return { content: "The boom tool couldn't complete that request.", isError: true };
      return { content: `result of ${name}` };
    },
    mayContinue: async (_u, iterations) => (iterations >= MAX_ITERATIONS ? { ok: false, reason: `the run reached its limit of ${MAX_ITERATIONS} turns` } : { ok: true }),
    recordCall: async (p, o) => {
      recorded.push([p, o]);
    },
    now: () => NOW,
    ...over,
  };
  return { d, model, dispatched, recorded };
}

describe("the agentic loop", () => {
  it("answers when the model asks for no tool, and the call is counted", async () => {
    const { d, model, recorded } = deps([{ text: "Done.", promptTokens: 80, outputTokens: 10 }]);
    const out = await runLoop({ task: "Do it", tools: TOOLS, maxOutputTokens: 100 }, d);
    expect(out).toMatchObject({ status: "succeeded", output: "Done.", iterations: 1, usage: { calls: 1, promptTokens: 80, outputTokens: 10 }, toolsUsed: [], reads: [] });
    expect(out.steps.map((s) => s.kind)).toEqual(["model"]);
    expect(recorded).toEqual([[80, 10]]);
    expect(model.requests[0]!.contents).toEqual([{ role: "user", parts: [{ text: "Do it" }] }]);
    expect(model.requests[0]!.tools).toEqual(TOOLS);
  });

  it("hands each call to the dispatcher and returns the results as DATA in a user turn; the model's parts are replayed verbatim; reads are tallied", async () => {
    const { d, model, dispatched } = deps([{ text: "Looking.", calls: [{ name: "note_read", args: { key: "tone" } }, { name: "memory_search", args: { query: "Anna" } }, { name: "boom", args: {} }] }, { text: "Warm it is." }]);
    const out = await runLoop({ task: "Write", tools: TOOLS, maxOutputTokens: 100 }, d);
    expect(out.status).toBe("succeeded");
    expect(out.output).toBe("Warm it is.");
    expect(dispatched.map((c) => c.name)).toEqual(["note_read", "memory_search", "boom"]);
    expect(model.requests[1]!.contents[1]).toEqual({ role: "model", parts: [{ text: "Looking." }, { functionCall: { name: "note_read", args: { key: "tone" } } }, { functionCall: { name: "memory_search", args: { query: "Anna" } } }, { functionCall: { name: "boom", args: {} } }] });
    expect(responsesOf(model.requests[1]!)).toEqual([
      { name: "note_read", response: { result: "result of note_read" } },
      { name: "memory_search", response: { result: "RESULTS…" } },
      { name: "boom", response: { error: "The boom tool couldn't complete that request." } },
    ]);
    expect(out.reads).toEqual([{ receipt: "rcpt-9", count: 2, bytes: 300 }]);
    expect(out.toolsUsed).toEqual(["note_read", "memory_search", "boom"]);
    expect(out.steps.map((s) => `${s.kind}: ${s.text}`)).toEqual(["model: Looking.", "tool: note_read key=tone", "result: result of note_read", "tool: memory_search query=Anna", "result: RESULTS…", "tool: boom", "result: The boom tool couldn't complete that request.", "model: Warm it is."]);
    expect(out.usage.calls).toBe(2);
  });

  it("pauses on ask_user — the pending response is a placeholder, later calls of the turn are 'not done' — and `answered` puts the answer where the model asked", async () => {
    const { d, dispatched } = deps([{ calls: [{ name: "ask_user", args: { question: "Sign it Marco?" } }, { name: "note_read", args: { key: "x" } }] }]);
    const out = await runLoop({ task: "Write", tools: TOOLS, maxOutputTokens: 100 }, d);
    expect(out.status).toBe("waiting");
    expect(out.question).toEqual({ question: "Sign it Marco?", draft: "Dear all" });
    expect(dispatched.map((c) => c.name)).toEqual(["ask_user"]);
    const last = out.contents[out.contents.length - 1] as { role: string; parts: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> };
    expect(last.parts.map((p) => p.functionResponse)).toEqual([
      { name: "ask_user", response: { result: PENDING_ANSWER } },
      { name: "note_read", response: { error: "Not done — the run paused for the user's answer first." } },
    ]);
    expect(out.steps.map((s) => s.kind)).toEqual(["tool", "asked"]);
    const resumed = answered(out.contents, "Yes, sign it.") as typeof out.contents;
    const again = resumed[resumed.length - 1] as typeof last;
    expect(again.parts[0]!.functionResponse.response).toEqual({ result: "The user answered: Yes, sign it." });
    expect(again.parts[1]!.functionResponse.response).toEqual({ error: "Not done — the run paused for the user's answer first." });
    expect(out.contents).not.toBe(resumed);
    // A conversation without a pending ask gets the answer as a new user turn.
    expect(answered([{ role: "user", parts: [{ text: "hi" }] }], "ok")).toHaveLength(2);
    // Resuming: no new task, the model is called straight away on the conversation.
    const next = deps([{ text: "Signed, Marco." }]);
    const done = await runLoop({ priorContents: resumed, tools: TOOLS, maxOutputTokens: 100 }, next.d);
    expect(done.status).toBe("succeeded");
    expect(next.model.requests[0]!.contents).toEqual(resumed);
  });

  it("stops at a turn boundary when the guard says no, on an answer cut short, and after the turn limit — saying why", async () => {
    const capped = deps([{ text: "never" }], { mayContinue: async () => ({ ok: false, reason: "this month's spending limit of $10.00 (at the ceiling) is reached" }) });
    const out = await runLoop({ task: "t", tools: [], maxOutputTokens: 10 }, capped.d);
    expect(out).toMatchObject({ status: "stopped", reason: "this month's spending limit of $10.00 (at the ceiling) is reached", iterations: 0, output: "" });
    expect(capped.model.requests).toHaveLength(0);

    const cut = deps([{ text: "Half an", truncated: true, calls: [{ name: "note_read", args: {} }] }]);
    const short = await runLoop({ task: "t", tools: TOOLS, maxOutputTokens: 10 }, cut.d);
    expect(short).toMatchObject({ status: "stopped", reason: CUT_SHORT, output: "Half an", iterations: 1 });
    expect(cut.dispatched).toEqual([]);

    const forever = deps(Array.from({ length: 20 }, () => ({ calls: [{ name: "note_read", args: {} }] })));
    const loopy = await runLoop({ task: "t", tools: TOOLS, maxOutputTokens: 10 }, forever.d);
    expect(loopy.status).toBe("stopped");
    expect(loopy.reason).toBe("the run reached its limit of 8 turns");
    expect(loopy.iterations).toBe(MAX_ITERATIONS);
    expect(forever.dispatched).toHaveLength(MAX_ITERATIONS);
  });
});
