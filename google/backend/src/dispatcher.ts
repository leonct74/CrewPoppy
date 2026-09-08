// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The TRUSTED tool dispatcher (DESIGN.md §4, §9; §18 G3c) — the single place an agent's intent
 * becomes a read, a write or a question. This module is to an agent what the AgentsPoppy broker
 * is to a poppy: it holds the doors, it decides what is permissible, and the thing it serves can
 * only ask. It is deliberately small and boring.
 *
 * The three invariants, restated where they are enforced:
 *   1. The agent can only name a tool from the FIXED catalogue. An unknown name is a refusal.
 *   2. An agent may only call tools ITS OWN DEFINITION enables — the list comes from the stored
 *      definition the RUNNER loaded, never from the model's request.
 *   3. Every location is derived from `agentId`, which the RUNNER supplies. Nothing the model
 *      writes is ever used to build a note or file id — which is why agent X cannot reach agent
 *      Y's data even if it asks perfectly. The user's memory is searched for the RUN'S purpose,
 *      through the host, with the receipt hints the runner set — the model chooses only the words.
 *
 * A tool failure is returned as an error RESULT, not thrown: the model should see "that didn't
 * work" and carry on, rather than killing a run the user is waiting on.
 */
import { memoryBytes } from "@agentspoppy/core";
import { searchResultsAsData } from "./material";
import type { MemoryReader, ReceiptHints } from "./memory-reader";
import type { FileRecord, NoteRecord } from "./store";
import { TOOL_LIMITS, type ToolName, isNoteKey, isSafeRelativePath, isToolName } from "./tools";

/** The store, as the dispatcher needs it — every call already scoped to one agent by the runner's id. */
export interface DispatchStore {
  note(agentId: string, key: string): Promise<NoteRecord | null>;
  saveNote(n: NoteRecord): Promise<void>;
  file(agentId: string, path: string): Promise<FileRecord | null>;
  saveFile(f: FileRecord): Promise<void>;
  files(agentId: string): Promise<FileRecord[]>;
}

export interface DispatchContext {
  /** From the stored agent definition — the root of every scoping decision. */
  agentId: string;
  agentName: string;
  /** The tools this agent's definition enables. */
  enabled: readonly string[];
  /** The run's purpose, in the user's words — on every memory receipt; never the model's. */
  purpose: string;
  hints: ReceiptHints;
  memory: MemoryReader | null;
  store: DispatchStore;
  timeZone: string;
  now: () => string;
  log?: (line: string) => void;
}

export interface ToolResult {
  /** Rendered back to the model as the function response. Always a string: it is DATA. */
  content: string;
  /** True when the tool refused or failed. The model sees this and can adapt. */
  isError?: boolean;
  /** Tells the loop to pause the run until the user answers (ask_user). */
  suspend?: { question: string; draft?: string };
  /** A memory read's receipt on the connection, and what it read — for the run's tally. */
  receipt?: string;
  read?: { count: number; bytes: number };
}

const MEMORY_SEARCH_LIMIT = 12;
const MEMORY_SEARCH_BUDGET = 4_000;

/** Execute one tool call on the agent's behalf. `args` is whatever the model produced. */
export async function dispatch(ctx: DispatchContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!isToolName(name)) return { content: `There is no tool called "${String(name).slice(0, 60)}".`, isError: true };
  if (!ctx.enabled.includes(name)) return { content: `You do not have the "${name}" tool.`, isError: true };
  try {
    return await run(ctx, name, args ?? {});
  } catch (e) {
    // Never hand Google's words to the model — they can name projects and databases. The log has them.
    ctx.log?.(`tool ${name} failed for ${ctx.agentId}: ${e instanceof Error ? e.message : String(e)}`);
    return { content: `The ${name} tool couldn't complete that request.`, isError: true };
  }
}

async function run(ctx: DispatchContext, name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "memory_search": {
      if (!ctx.memory) return { content: "The user's memory is not reachable from here.", isError: true };
      const query = short(args.query, TOOL_LIMITS.query);
      if (!query) return { content: "memory_search needs a 'query' — a few plain words.", isError: true };
      const kind = args.kind === "event" || args.kind === "person" ? args.kind : undefined;
      // The purpose and the hints are the RUN'S; the model chose only the words to look for.
      const page = await ctx.memory.search({ purpose: ctx.purpose, query, ...(kind ? { kinds: [kind] } : {}), limit: MEMORY_SEARCH_LIMIT, budget: MEMORY_SEARCH_BUDGET, ...ctx.hints });
      return {
        content: searchResultsAsData(page.memories, ctx.timeZone, query),
        receipt: page.receipt,
        read: { count: page.memories.length, bytes: page.memories.reduce((n, m) => n + memoryBytes(m), 0) },
      };
    }
    case "note_read": {
      if (!isNoteKey(args.key)) return { content: "note_read needs a 'key' — a short name.", isError: true };
      const note = await ctx.store.note(ctx.agentId, args.key);
      return { content: note ? note.value : `Nothing is noted under "${args.key.trim()}".` };
    }
    case "note_write": {
      if (!isNoteKey(args.key)) return { content: "note_write needs a 'key' — a short name.", isError: true };
      const value = typeof args.value === "string" ? args.value : "";
      if (!value.trim()) return { content: "note_write needs a 'value'.", isError: true };
      if (value.length > TOOL_LIMITS.noteValue) return { content: `That is too long to keep as a note (limit ${TOOL_LIMITS.noteValue.toLocaleString("en-GB")} characters).`, isError: true };
      await ctx.store.saveNote({ agent: ctx.agentId, key: args.key.trim(), value, updatedAt: ctx.now() });
      return { content: `Noted under "${args.key.trim()}".` };
    }
    case "file_list": {
      const files = await ctx.store.files(ctx.agentId);
      if (files.length === 0) return { content: "Your folder is empty." };
      return { content: files.map((f) => `${f.path} — ${f.content.length.toLocaleString("en-GB")} characters, updated ${f.updatedAt.slice(0, 16).replace("T", " ")}`).join("\n") };
    }
    case "file_read": {
      if (!isSafeRelativePath(args.path)) return { content: "file_read needs a 'path' — a file name inside your folder.", isError: true };
      const file = await ctx.store.file(ctx.agentId, args.path);
      if (!file) return { content: `There is no file called "${args.path.trim()}" in your folder.`, isError: true };
      return { content: file.content.length > TOOL_LIMITS.readChars ? `${file.content.slice(0, TOOL_LIMITS.readChars)}\n…(cut at ${TOOL_LIMITS.readChars.toLocaleString("en-GB")} characters)` : file.content };
    }
    case "file_write": {
      if (!isSafeRelativePath(args.path)) return { content: "file_write needs a 'path' — a file name inside your folder.", isError: true };
      const content = typeof args.content === "string" ? args.content : "";
      if (content.length > TOOL_LIMITS.fileChars) return { content: `That file is too big (limit ${TOOL_LIMITS.fileChars.toLocaleString("en-GB")} characters).`, isError: true };
      await ctx.store.saveFile({ agent: ctx.agentId, path: args.path.trim(), content, updatedAt: ctx.now() });
      return { content: `Saved "${args.path.trim()}" (${content.length.toLocaleString("en-GB")} characters).` };
    }
    case "file_append": {
      if (!isSafeRelativePath(args.path)) return { content: "file_append needs a 'path' — a file name inside your folder.", isError: true };
      const line = typeof args.line === "string" ? args.line.replace(/\s*[\r\n]+\s*/g, " ").trim() : "";
      if (!line) return { content: "file_append needs a 'line'.", isError: true };
      if (line.length > TOOL_LIMITS.line) return { content: `That line is too long (limit ${TOOL_LIMITS.line.toLocaleString("en-GB")} characters).`, isError: true };
      const existing = (await ctx.store.file(ctx.agentId, args.path))?.content ?? "";
      const content = `${existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`}${line}\n`;
      if (content.length > TOOL_LIMITS.fileChars) return { content: "That file is full — start a new one.", isError: true };
      await ctx.store.saveFile({ agent: ctx.agentId, path: args.path.trim(), content, updatedAt: ctx.now() });
      return { content: `Added a line to "${args.path.trim()}" (now ${content.split("\n").length - 1} lines).` };
    }
    case "ask_user": {
      const question = short(args.question, TOOL_LIMITS.question);
      if (!question) return { content: "ask_user needs a 'question'.", isError: true };
      const draft = short(args.draft, TOOL_LIMITS.draft);
      // Nothing is persisted here: the LOOP pauses and the RUNNER keeps the conversation.
      return { content: "Asked the user. The run pauses here until they answer.", suspend: draft ? { question, draft } : { question } };
    }
  }
}

function short(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}
