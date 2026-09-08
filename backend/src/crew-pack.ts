// The Crew Pack — this edition's edge of the shared format (DESIGN §3b; §18 "one product with
// the live app", step 2). Everything the crew learned leaves as one JSON file the owner holds —
// the agents, the memory they wrote for themselves, their workspace files — and comes back here,
// after a teardown or from the Google edition. Runs and transcripts are history, not knowledge;
// they stay where they were made.
//
// The pack speaks the live app's terms already (shared/src/pack.ts), so this edge is small: a
// Bedrock model id becomes a model CLASS on the way out and a catalogue pick on the way in;
// binary files travel as base64; what does not travel is said in `omitted`, never dropped in
// silence. Imports go through `saveAgent` — the same sanitisers as the editor — so a pack can
// never store what the form could not.
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type AgentDef, DEFAULT_MODEL_ID, MODEL_CATALOGUE, TOOL_NAMES, isSafeRelativePath, memoryPk, memorySk, workspaceKeyFor } from "@crewpoppy/shared";
import { type CrewPack, PACK_FILENAME, PACK_FORMAT, PACK_VERSION, type PackAgent, type PackFile, type PackModel, type PackNote, type PackSchedule, isPackModel } from "../../shared/src/pack";
import { type AgentInput, getAgent, listAgents, listFiles, putOwnerFile, readFileContent, saveAgent } from "./agents";

export { PACK_FILENAME, PACK_VERSION };

/** The poppy id the live app publishes under. */
export const POPPY_ID = "com.crewpoppy.desktop";
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const BINARY = /\.(pdf|png|jpe?g|gif|webp|zip|xlsx|docx|pptx)$/i;
/** A file over this does not travel; the pack says so. */
export const MAX_PACK_FILE_BYTES = 5 * 1024 * 1024;
/** What memory_write would accept (lambdas/src/dispatcher.ts). */
const MAX_MEMORY_VALUE = 100_000;
const MAX_MEMORY_KEY = 200;
/** A task-less schedule from the Google edition runs the agent on its brief; here a run needs words. */
export const BRIEF_TASK = "Do the job as briefed.";

const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", zip: "application/zip", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

/** A Bedrock model id as the pack's class — the Google edition reads it as a tier. */
export function modelClassOf(modelId: string): PackModel {
  const id = modelId.toLowerCase();
  if (/haiku|nova-lite|nova-micro|-mini|-small/.test(id)) return "light";
  if (/opus/.test(id)) return "deep";
  return "standard";
}

/** The catalogue's pick for a class: the default (cheap, a good instruction-follower) for light and auto, the best it lists otherwise. */
export function modelIdFor(cls: PackModel | undefined): string {
  if (!cls || cls === "auto" || cls === "light") return DEFAULT_MODEL_ID;
  return MODEL_CATALOGUE.find((m) => /sonnet/i.test(m.id))?.id ?? DEFAULT_MODEL_ID;
}

/** One of this edition's agents as the pack carries it. */
export function toPackAgent(a: AgentDef): PackAgent {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    instructions: a.instructions,
    tools: [...a.tools],
    capUsd: a.caps.monthlySpendCapUsd,
    model: modelClassOf(a.modelId),
    ...(a.avatar ? { avatar: a.avatar } : {}),
    ...(a.schedule ? { schedule: { kind: a.schedule.kind, hour: a.schedule.hour, minute: a.schedule.minute, weekday: a.schedule.weekday, timezone: a.schedule.timezone, task: a.schedule.task, enabled: a.schedule.enabled } } : {}),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

async function readFileBytes(s3: S3Client, bucket: string, agentId: string, path: string): Promise<Uint8Array | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: workspaceKeyFor(agentId, path) }));
    return (await r.Body?.transformToByteArray()) ?? null;
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name === "NoSuchKey" || name === "NoSuchBucket" || name === "NotFound") return null;
    throw e;
  }
}

/** The whole crew as one pack: every agent, what each remembered, every file it holds. */
export async function buildCrewPack(ddb: DynamoDBDocumentClient, table: string, s3: S3Client, bucket: string, now: string): Promise<CrewPack> {
  const agents = await listAgents(ddb, table, now);
  const notes: PackNote[] = [];
  const files: PackFile[] = [];
  const omitted: string[] = [];
  for (const a of agents) {
    const r = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": memoryPk(a.id) } }));
    for (const it of (r.Items ?? []) as Array<{ key?: unknown; value?: unknown }>) {
      if (typeof it.key === "string" && typeof it.value === "string") notes.push({ agent: a.id, key: it.key, value: it.value });
    }
    for (const f of await listFiles(s3, bucket, a.id)) {
      if (f.size > MAX_PACK_FILE_BYTES) {
        omitted.push(`${a.name}'s ${f.path} — over 5 MB`);
        continue;
      }
      const stamp = f.modified ? { updatedAt: f.modified } : {};
      if (BINARY.test(f.path)) {
        const bytes = await readFileBytes(s3, bucket, a.id, f.path);
        if (bytes) files.push({ agent: a.id, path: f.path, content: Buffer.from(bytes).toString("base64"), encoding: "base64", ...stamp });
        continue;
      }
      const text = await readFileContent(s3, bucket, a.id, f.path);
      if (text !== null) files.push({ agent: a.id, path: f.path, content: text, ...stamp });
    }
  }
  return { format: PACK_FORMAT, version: PACK_VERSION, exportedAt: now, edition: "aws", poppy: POPPY_ID, agents: agents.map(toPackAgent), notes, files, ...(omitted.length > 0 ? { omitted } : {}) };
}

export interface PackPlan {
  applied: boolean;
  /** Agents that would be (or were) created and updated, by name. */
  create: string[];
  update: string[];
  notes: number;
  files: number;
  /** What was left out or changed on the way in, and why — in the owner's words. */
  skipped: string[];
  totalMonthlyCapUsd: number;
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";

interface Prepared {
  id: string;
  name: string;
  input: AgentInput;
  notes: string[];
}

/** A pack's agent as `saveAgent` takes it — the model picked by class, unknown tools left off and said, a task-less schedule given words. */
function prepare(p: Partial<PackAgent>, existing: AgentDef | null, defaultTimezone: string): Prepared | { problem: string } {
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name) return { problem: "(unnamed): a name is needed" };
  const notes: string[] = [];
  const tools = (Array.isArray(p.tools) ? p.tools : []).filter((t): t is string => typeof t === "string");
  const known = tools.filter((t) => (TOOL_NAMES as readonly string[]).includes(t));
  for (const t of tools.filter((t) => !known.includes(t))) notes.push(`${name}: no tool is called "${t}" here — left off`);
  const cls: PackModel = isPackModel(p.model) ? p.model : "auto";
  const modelId = existing && (cls === "auto" || modelClassOf(existing.modelId) === cls) ? existing.modelId : modelIdFor(cls);
  let schedule: Record<string, unknown> | null = null;
  if (p.schedule && typeof p.schedule === "object") {
    const s = p.schedule as Partial<PackSchedule>;
    const task = typeof s.task === "string" && s.task.trim() ? s.task : BRIEF_TASK;
    if (task === BRIEF_TASK) notes.push(`${name}'s schedule had no task — set to "${BRIEF_TASK}"`);
    schedule = { kind: s.kind, hour: s.hour, minute: s.minute, weekday: s.weekday, timezone: typeof s.timezone === "string" && s.timezone ? s.timezone : defaultTimezone, task, enabled: s.enabled !== false };
  }
  const capUsd = Number(p.capUsd);
  const id = typeof p.id === "string" && ID_RE.test(p.id) ? p.id : existing?.id ?? slug(name);
  return {
    id,
    name,
    input: {
      name,
      role: typeof p.role === "string" ? p.role : "",
      instructions: typeof p.instructions === "string" ? p.instructions : "",
      modelId,
      tools: known,
      ...(typeof p.avatar === "string" ? { avatar: p.avatar } : {}),
      schedule,
      caps: { monthlySpendCapUsd: Number.isFinite(capUsd) && capUsd > 0 ? capUsd : existing?.caps.monthlySpendCapUsd ?? 5 },
    },
    notes,
  };
}

async function walk(ddb: DynamoDBDocumentClient, table: string, s3: S3Client | null, bucket: string, pack: CrewPack, now: string, defaultTimezone: string, apply: boolean): Promise<PackPlan> {
  const plan: PackPlan = { applied: apply, create: [], update: [], notes: 0, files: 0, skipped: [], totalMonthlyCapUsd: 0 };
  const kept = new Set<string>();
  for (const raw of pack.agents) {
    const p = (raw ?? {}) as Partial<PackAgent>;
    const existing = typeof p.id === "string" && ID_RE.test(p.id) ? await getAgent(ddb, table, p.id) : null;
    const prepared = prepare(p, existing, defaultTimezone);
    if ("problem" in prepared) {
      plan.skipped.push(prepared.problem);
      continue;
    }
    if (apply) {
      try {
        await saveAgent(ddb, table, prepared.id, prepared.input, now);
      } catch (e) {
        plan.skipped.push(`${prepared.name}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    } else if (!prepared.input.role || !prepared.input.instructions) {
      plan.skipped.push(`${prepared.name}: a role and instructions are needed`);
      continue;
    }
    (existing ? plan.update : plan.create).push(prepared.name);
    plan.skipped.push(...prepared.notes);
    plan.totalMonthlyCapUsd += prepared.input.caps?.monthlySpendCapUsd ?? 0;
    kept.add(prepared.id);
  }
  for (const raw of pack.notes) {
    const n = (raw ?? {}) as Partial<PackNote>;
    if (typeof n.agent !== "string" || !kept.has(n.agent)) continue;
    const key = typeof n.key === "string" ? n.key.trim() : "";
    if (!key || key.length > MAX_MEMORY_KEY || typeof n.value !== "string" || !n.value || n.value.length > MAX_MEMORY_VALUE) {
      plan.skipped.push(`a memory of ${n.agent} ("${key.slice(0, 40)}") — not one memory_write would keep`);
      continue;
    }
    if (apply) await ddb.send(new PutCommand({ TableName: table, Item: { pk: memoryPk(n.agent), sk: memorySk(key), key, value: n.value } }));
    plan.notes += 1;
  }
  for (const raw of pack.files) {
    const f = (raw ?? {}) as Partial<PackFile>;
    if (typeof f.agent !== "string" || !kept.has(f.agent)) continue;
    const label = `a file of ${f.agent} ("${String(f.path ?? "").slice(0, 60)}")`;
    if (!isSafeRelativePath(f.path) || typeof f.content !== "string" || !f.content) {
      plan.skipped.push(`${label} — not a file the workspace would keep`);
      continue;
    }
    if (f.encoding === "base64") {
      const bytes = Buffer.from(f.content, "base64");
      if (bytes.length === 0 || bytes.length > MAX_PACK_FILE_BYTES) {
        plan.skipped.push(`${label} — empty, or over 5 MB`);
        continue;
      }
      if (apply && s3) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: workspaceKeyFor(f.agent, f.path), Body: bytes, ContentType: MIME[f.path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream" }));
      plan.files += 1;
      continue;
    }
    if (apply && s3) {
      const put = await putOwnerFile(s3, bucket, f.agent, f.path, f.content);
      if (!put.ok) {
        plan.skipped.push(`${label} — ${put.reason ?? "not kept"}`);
        continue;
      }
    } else if (Buffer.byteLength(f.content) > 500_000) {
      plan.skipped.push(`${label} — over 500 KB`);
      continue;
    }
    plan.files += 1;
  }
  return plan;
}

/** What bringing this pack in would do — nothing written. */
export function planCrewPack(ddb: DynamoDBDocumentClient, table: string, pack: CrewPack, now: string, defaultTimezone = "UTC"): Promise<PackPlan> {
  return walk(ddb, table, null, "", pack, now, defaultTimezone, false);
}

/** Bring the pack in: agents through the editor's own sanitisers, memories and files only for agents that exist afterwards. */
export function applyCrewPack(ddb: DynamoDBDocumentClient, table: string, s3: S3Client, bucket: string, pack: CrewPack, now: string, defaultTimezone = "UTC"): Promise<PackPlan> {
  return walk(ddb, table, s3, bucket, pack, now, defaultTimezone, true);
}
