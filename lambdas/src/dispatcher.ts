// The TRUSTED tool dispatcher (DESIGN §4, §9) — the single place an agent's intent
// becomes an AWS call.
//
// This module is to an agent what the AgentsPoppy broker is to a poppy: it holds the
// credentials, it decides what is permissible, and the thing it serves can only ask.
// Everything security-critical about CrewPoppy lives here, so it is deliberately small
// and boring.
//
// The three invariants, restated where they are enforced:
//
//   1. The agent can only name a tool from the FIXED catalogue. An unknown name is a
//      refusal, never a crash and never a passthrough.
//   2. An agent may only call tools ITS OWN DEFINITION enables. The list comes from the
//      stored definition, not from the model's request.
//   3. Every location is derived from `agentId`, which the RUNNER supplies from the
//      loaded definition. Nothing the model writes is ever used to build a key or path.
//      This is why agent X cannot reach agent Y's data even if it asks perfectly.
//
// A tool failure is returned as an error RESULT, not thrown: the model should see "that
// didn't work" and carry on, exactly as it would with any other tool, rather than
// killing a run the user is waiting on.

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  isSafeRelativePath,
  isToolName,
  memoryPk,
  memorySk,
  workspaceKeyFor,
  workspacePrefixFor,
  type ToolName,
} from "@crewpoppy/shared";

/** Everything a tool may use. Note what is ABSENT: no credentials, no arbitrary client. */
export interface DispatchContext {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  table: string;
  bucket: string;
  /** From the stored agent definition — the root of every scoping decision. */
  agentId: string;
  /** The tools this agent's definition enables. */
  enabled: readonly string[];
}

export interface ToolResult {
  /** Rendered back to the model as the tool result. Always a string: it is DATA. */
  content: string;
  /** True when the tool refused or failed. The model sees this and can adapt. */
  isError?: boolean;
  /**
   * Set by `ask_user` only. Tells the runner to checkpoint and stop — the run resumes in
   * a fresh invocation once the owner answers (DESIGN §5).
   */
  suspend?: { question: string; draft?: string };
}

const MAX_MEMORY_VALUE = 100_000;
const MAX_FILE_BYTES = 500_000;

/**
 * Execute one tool call on the agent's behalf.
 *
 * `args` is whatever the model produced — untrusted, unvalidated, possibly hostile. It is
 * treated as such: every field is checked before use, and no field ever contributes to a
 * key, prefix or table name.
 */
export async function dispatch(
  ctx: DispatchContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // (1) Fixed catalogue.
  if (!isToolName(name)) {
    return { content: `There is no tool called "${String(name).slice(0, 60)}".`, isError: true };
  }
  // (2) Per-agent allowlist, from the stored definition.
  if (!ctx.enabled.includes(name)) {
    return { content: `You do not have the "${name}" tool enabled.`, isError: true };
  }

  try {
    return await run(ctx, name, args);
  } catch (e) {
    // Never leak an AWS error verbatim to the model: it can name buckets, tables and
    // account ids, which is information the agent has no business learning.
    return { content: `The ${name} tool couldn't complete that request.`, isError: true };
  }
}

async function run(ctx: DispatchContext, name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "memory_read": {
      const key = asShortString(args.key);
      if (!key) return { content: "memory_read needs a 'key'.", isError: true };
      const r = await ctx.ddb.send(
        // (3) Partition derived from agentId. Another agent's memory is unreachable
        //     because its partition is never constructed here.
        new GetCommand({ TableName: ctx.table, Key: { pk: memoryPk(ctx.agentId), sk: memorySk(key) } }),
      );
      const value = (r.Item as { value?: string } | undefined)?.value;
      return { content: value ?? `Nothing is stored under "${key}".` };
    }

    case "memory_write": {
      const key = asShortString(args.key);
      const value = typeof args.value === "string" ? args.value : "";
      if (!key) return { content: "memory_write needs a 'key'.", isError: true };
      if (!value) return { content: "memory_write needs a 'value'.", isError: true };
      if (value.length > MAX_MEMORY_VALUE) {
        return { content: `That's too long to remember (limit ${MAX_MEMORY_VALUE} characters).`, isError: true };
      }
      await ctx.ddb.send(
        new PutCommand({
          TableName: ctx.table,
          Item: { pk: memoryPk(ctx.agentId), sk: memorySk(key), key, value },
        }),
      );
      return { content: `Remembered under "${key}".` };
    }

    case "workspace_list": {
      const r = await ctx.s3.send(
        new ListObjectsV2Command({ Bucket: ctx.bucket, Prefix: workspacePrefixFor(ctx.agentId) }),
      );
      const prefix = workspacePrefixFor(ctx.agentId);
      const names = (r.Contents ?? []).map((o) => (o.Key ?? "").slice(prefix.length)).filter(Boolean);
      return { content: names.length ? names.join("\n") : "Your workspace is empty." };
    }

    case "workspace_read": {
      const path = args.path;
      if (!isSafeRelativePath(path)) return { content: badPath(), isError: true };
      const r = await ctx.s3.send(
        new GetObjectCommand({ Bucket: ctx.bucket, Key: workspaceKeyFor(ctx.agentId, path) }),
      );
      const body = await r.Body?.transformToString();
      return { content: body ?? "" };
    }

    case "workspace_write": {
      const path = args.path;
      const content = typeof args.content === "string" ? args.content : "";
      if (!isSafeRelativePath(path)) return { content: badPath(), isError: true };
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
        return { content: `That file is too large (limit ${MAX_FILE_BYTES} bytes).`, isError: true };
      }
      await ctx.s3.send(
        new PutObjectCommand({
          Bucket: ctx.bucket,
          Key: workspaceKeyFor(ctx.agentId, path),
          Body: content,
          ContentType: "text/plain; charset=utf-8",
        }),
      );
      return { content: `Saved ${path}.` };
    }

    case "ask_user": {
      const question = asLongString(args.question);
      if (!question) return { content: "ask_user needs a 'question'.", isError: true };
      const draft = asLongString(args.draft);
      // The dispatcher does not persist anything here: it tells the RUNNER to checkpoint
      // and stop, so suspend/resume stays in one place (DESIGN §5).
      return {
        content: "Asked the owner. The run pauses here until they answer.",
        suspend: draft ? { question, draft } : { question },
      };
    }
  }
}

/** Deliberately identical for every rejection, so probing reveals nothing about layout. */
function badPath(): string {
  return "That file name isn't allowed. Use a plain name inside your own workspace, with no leading slash and no '..'.";
}

function asShortString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= 256 ? s : null;
}

function asLongString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, 20_000) : undefined;
}

/** Unused import guard — `DeleteObjectCommand` is reserved for a delete tool at P3. */
void DeleteObjectCommand;
