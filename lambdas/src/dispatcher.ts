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
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { renderPdf } from "./pdf";
import { buildRawEmail, type MimeAttachment } from "./mime";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import {
  dayKeyOf,
  isEmailAddress,
  isSafeRelativePath,
  isToolName,
  memoryPk,
  memorySk,
  normaliseEmail,
  sendCountPk,
  sendCountSk,
  workspaceKeyFor,
  workspacePrefixFor,
  type PendingSend,
  type ToolName,
} from "@crewpoppy/shared";

/** Everything a tool may use. Note what is ABSENT: no credentials, no arbitrary client. */
export interface DispatchContext {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  ses: SESv2Client;
  table: string;
  bucket: string;
  /** From the stored agent definition — the root of every scoping decision. */
  agentId: string;
  /** Shown as the sender's display name, never used to build a key. */
  agentName: string;
  /** The tools this agent's definition enables. */
  enabled: readonly string[];
  /** Where `email_owner` goes. Install configuration — never a tool argument. */
  ownerEmail?: string;
  /** The verified identity this agent sends FROM. Defaults to the owner's address. */
  fromAddress?: string;
  /** Hard ceiling on messages per agent per day. */
  maxEmailsPerDay: number;
  /** Injected so tests don't depend on the wall clock. */
  now?: () => number;
}

export interface ToolResult {
  /** Rendered back to the model as the tool result. Always a string: it is DATA. */
  content: string;
  /** True when the tool refused or failed. The model sees this and can adapt. */
  isError?: boolean;
  /**
   * Tells the runner to checkpoint and stop — the run resumes in a fresh invocation once
   * the owner answers (DESIGN §5). Set by `ask_user`, and by `send_email` for any
   * recipient who isn't the owner.
   */
  suspend?: {
    question: string;
    draft?: string;
    /** The exact action awaiting approval, stored so it is what actually happens. */
    pending?: PendingSend;
  };
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

    case "email_owner": {
      const subject = asShortString(args.subject);
      const body = asLongString(args.body);
      if (!subject) return { content: "email_owner needs a 'subject'.", isError: true };
      if (!body) return { content: "email_owner needs a 'body'.", isError: true };
      if (!ctx.ownerEmail) return { content: NO_OWNER_ADDRESS, isError: true };
      return sendMail(ctx, ctx.ownerEmail, subject, body, asShortString(args.attach) ?? undefined);
    }

    case "send_email": {
      const subject = asShortString(args.subject);
      const body = asLongString(args.body);
      const to = typeof args.to === "string" ? args.to.trim() : "";
      if (!isEmailAddress(to)) {
        return { content: "send_email needs a single valid 'to' address.", isError: true };
      }
      if (!subject) return { content: "send_email needs a 'subject'.", isError: true };
      if (!body) return { content: "send_email needs a 'body'.", isError: true };
      if (!ctx.ownerEmail) return { content: NO_OWNER_ADDRESS, isError: true };

      // An attachment is validated NOW, at propose time: a bad name should bounce back
      // to the model immediately, not surface as a failure after the owner approved.
      const attach = asShortString(args.attach) ?? undefined;
      if (attach && !isSafeRelativePath(attach)) return { content: badPath(), isError: true };

      // Writing to your owner is not "reaching the outside world" — it's the same inbox
      // `email_owner` uses, so it doesn't need approving.
      if (normaliseEmail(to) === normaliseEmail(ctx.ownerEmail)) {
        return sendMail(ctx, ctx.ownerEmail, subject, body, attach);
      }

      // THE GATE (DESIGN §4c). Nothing is sent here. The message is handed to the runner
      // to store and show the owner, and it is sent — if at all — from that stored copy.
      //
      // This is deliberately NOT left to the agent's instructions. A prompt that says
      // "always ask before emailing" is text, and text is what an attacker gets to write.
      // The refusal to send has to be structural, so it holds for an agent that has been
      // argued into anything at all.
      return {
        content: "Waiting for your owner to approve this message. It has not been sent.",
        suspend: {
          question: `${ctx.agentName} wants to email ${to}.`,
          draft: `To: ${to}\nSubject: ${subject}${attach ? `\nAttachment: ${attach}` : ""}\n\n${body}`,
          pending: { kind: "send_email", to, subject, body, ...(attach ? { attach } : {}) },
        },
      };
    }

    case "save_pdf": {
      const path = args.path;
      const body = typeof args.body === "string" ? args.body : "";
      // The extension is part of the contract: the Files panel decides "open in the
      // browser" vs "show as text" by it, and a PDF pretending to be .md helps nobody.
      if (!isSafeRelativePath(path) || !path.toLowerCase().endsWith(".pdf")) {
        return { content: "save_pdf needs a plain file name ending in .pdf, inside your workspace.", isError: true };
      }
      if (!body.trim()) return { content: "save_pdf needs a 'body' with the document's content.", isError: true };
      if (body.length > 200_000) {
        return { content: "That document is too long (limit 200,000 characters).", isError: true };
      }
      const bytes = renderPdf(body, asShortString(args.title) ?? undefined);
      await ctx.s3.send(
        new PutObjectCommand({
          Bucket: ctx.bucket,
          Key: workspaceKeyFor(ctx.agentId, path),
          Body: Buffer.from(bytes),
          ContentType: "application/pdf",
        }),
      );
      return { content: `Saved ${path} as a PDF (${Math.ceil(bytes.length / 1024)} KB).` };
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

const NO_OWNER_ADDRESS =
  "No email address is set up for your owner yet, so you cannot send mail. Tell them that in your answer.";

/**
 * Actually put a message on the wire.
 *
 * Called for the owner's own address, and by the RUNNER for a message the owner approved
 * — never straight from a model's request to a stranger. The daily ceiling is claimed
 * BEFORE the send: a counter incremented after the fact is not a limit, it's a tally.
 */
const MAX_ATTACHMENT_BYTES = 7_000_000; // under SES's raw-message ceiling, with MIME room

/** What a filename claims to be. The workspace only ever holds text and our own PDFs. */
function contentTypeFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  return "text/plain; charset=utf-8";
}

export async function sendMail(
  ctx: DispatchContext,
  to: string,
  subject: string,
  body: string,
  /** Workspace file name. Fetched HERE, from this agent's own prefix — never from args. */
  attach?: string,
): Promise<ToolResult> {
  const from = ctx.fromAddress || ctx.ownerEmail;
  if (!from) return { content: NO_OWNER_ADDRESS, isError: true };

  // The attachment is fetched BEFORE the daily allowance is claimed: a missing file must
  // not burn one of the day's sends.
  let attachment: MimeAttachment | undefined;
  if (attach) {
    if (!isSafeRelativePath(attach)) return { content: badPath(), isError: true };
    try {
      const r = await ctx.s3.send(
        new GetObjectCommand({ Bucket: ctx.bucket, Key: workspaceKeyFor(ctx.agentId, attach) }),
      );
      const bytes = await r.Body?.transformToByteArray();
      if (!bytes) throw new Error("empty");
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        return { content: `That attachment is too large to email (limit ${Math.floor(MAX_ATTACHMENT_BYTES / 1_000_000)} MB).`, isError: true };
      }
      attachment = {
        filename: attach.split("/").pop() ?? "attachment",
        content: bytes,
        contentType: contentTypeFor(attach),
      };
    } catch {
      return {
        content: `There is no file called "${attach}" in your workspace, so nothing was sent. Save it first.`,
        isError: true,
      };
    }
  }

  if (!(await claimDailySend(ctx))) {
    return {
      content: `You have reached your limit of ${ctx.maxEmailsPerDay} emails today. Say so in your answer rather than trying again.`,
      isError: true,
    };
  }

  // The display name is the agent's, the address is the owner's verified identity —
  // warm, and still traceable to a real mailbox someone can reply to.
  const fromHeader = `${sanitiseDisplayName(ctx.agentName)} <${from}>`;
  await ctx.ses.send(
    new SendEmailCommand(
      attachment
        ? {
            // Attachments need the raw MIME path — SES's Simple content can't carry them.
            FromEmailAddress: fromHeader,
            Destination: { ToAddresses: [to] },
            Content: { Raw: { Data: buildRawEmail({ from: fromHeader, to, subject, body, attachment }) } },
          }
        : {
            FromEmailAddress: fromHeader,
            Destination: { ToAddresses: [to] },
            Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: body } } } },
          },
    ),
  );
  return { content: attachment ? `Sent to ${to}, with ${attachment.filename} attached.` : `Sent to ${to}.` };
}

/**
 * Take one from today's allowance, atomically. Returns false when the ceiling is already
 * reached — the condition is what makes this safe against two runs at once, where a
 * read-then-write would let both through.
 */
async function claimDailySend(ctx: DispatchContext): Promise<boolean> {
  const nowMs = (ctx.now ?? Date.now)();
  const day = dayKeyOf(new Date(nowMs).toISOString());
  try {
    await ctx.ddb.send(
      new UpdateCommand({
        TableName: ctx.table,
        Key: { pk: sendCountPk(ctx.agentId), sk: sendCountSk(day) },
        UpdateExpression: "ADD n :one SET expiresAt = :exp",
        ConditionExpression: "attribute_not_exists(n) OR n < :max",
        ExpressionAttributeValues: {
          ":one": 1,
          ":max": ctx.maxEmailsPerDay,
          // Yesterday's counter is of no interest to anyone; let DynamoDB clear it.
          ":exp": Math.floor(nowMs / 1000) + 14 * 24 * 60 * 60,
        },
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** A display name can't be allowed to smuggle a second address into the From header. */
function sanitiseDisplayName(name: string): string {
  return name.replace(/[<>@",;:\\\r\n]/g, "").trim().slice(0, 60) || "CrewPoppy";
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
