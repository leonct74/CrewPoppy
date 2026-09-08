// The Crew Pack — ONE file both editions write and read (DESIGN §3b; §18 "one product with
// the live app", step 2). Everything a crew learned, in the owner's hands: the agents, the notes
// they kept (their own memory), their files. Nothing in it is a credential or a receipt.
//
// The pack speaks the live app's terms — tool names from shared/src/tools.ts, the schedule shape
// of shared/src/schedule.ts, a model CLASS rather than a vendor's model id — and each edition
// converts at its own edge: the AWS edition picks a Bedrock model for the class, the Google
// edition maps the tools to its own catalogue and says which abilities it lacks. So a crew moves
// from AWS to Google and back, and what cannot travel is said, never dropped in silence.
//
// Not exported from the barrel (like recipes.ts): the Lambda never reads a pack, and its bundle
// hash must not move for desktop-only code. The sidecar and the Google edition import this file.

export const PACK_FORMAT = "crewpoppy-crew-pack";
/** 1 was the Google edition's own shape (2026-09-08, before the shared format); 2 is this file. */
export const PACK_VERSION = 2;
export const PACK_FILENAME = "crewpoppy-crew-pack.json";
export const PACK_MAX_AGENTS = 100;
export const PACK_MAX_ITEMS = 2_000;

export type PackEdition = "aws" | "google";

/** A model class, never a vendor id: each edition has its own catalogue. */
export const PACK_MODELS = ["auto", "light", "standard", "deep"] as const;
export type PackModel = (typeof PACK_MODELS)[number];

/** The live app's schedule shape (shared/src/schedule.ts) — the owner's own clock, never cron. */
export interface PackSchedule {
  kind: "hourly" | "daily" | "weekly";
  hour: number;
  minute: number;
  /** 0 = Sunday. Weekly only. */
  weekday: number;
  /** IANA zone; "" = the importing owner's own. */
  timezone: string;
  /** What the agent is handed on each run; "" = its brief (the Google edition's reading). */
  task: string;
  enabled: boolean;
}

export interface PackAgent {
  id: string;
  name: string;
  role: string;
  instructions: string;
  /** The live app's tool names (shared/src/tools.ts). */
  tools: string[];
  /** The monthly cap in dollars. */
  capUsd: number;
  model?: PackModel;
  /** A face from the live app's catalogue ("av-01"…); the Google edition keeps it for the trip back. */
  avatar?: string;
  /** May it read the owner's memory poppy (the Google edition); absent = that edition's default. */
  memory?: boolean;
  schedule?: PackSchedule;
  createdAt?: string;
  updatedAt?: string;
}

/** One thing an agent chose to remember — the live app's memory_write, the Google edition's notes. */
export interface PackNote {
  agent: string;
  key: string;
  value: string;
  updatedAt?: string;
}

export interface PackFile {
  agent: string;
  path: string;
  content: string;
  /** Set when `content` is base64 of a binary file (a PDF); absent = UTF-8 text. */
  encoding?: "base64";
  updatedAt?: string;
}

export interface CrewPack {
  format: typeof PACK_FORMAT;
  version: number;
  exportedAt: string;
  edition: PackEdition;
  /** The poppy that made it, e.g. "com.crewpoppy.cloud.google". */
  poppy: string;
  agents: PackAgent[];
  notes: PackNote[];
  files: PackFile[];
  /** What the exporter left out, and why — in the owner's words. */
  omitted?: string[];
}

export function isPackModel(v: unknown): v is PackModel {
  return typeof v === "string" && (PACK_MODELS as readonly string[]).includes(v);
}

export function describePackEdition(e: PackEdition): string {
  return e === "google" ? "the Google edition" : "the AWS edition";
}

const objects = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/**
 * A pack someone hands us: the envelope checked before anything of it is kept — the format, the
 * version, the size. Each agent, note and file is then judged by the importing edition's own
 * validators, so a pack can never store what that edition's form could not.
 */
export function readCrewPack(input: unknown): { pack: CrewPack } | { error: string } {
  if (!input || typeof input !== "object") return { error: "That is not a Crew Pack — expected a JSON object." };
  const p = input as Record<string, unknown>;
  if (p.format !== PACK_FORMAT) return { error: `That is not a Crew Pack — its format is "${String(p.format ?? "missing").slice(0, 40)}".` };
  if (typeof p.version !== "number" || p.version > PACK_VERSION || p.version < 1) {
    return { error: `This Crew Pack is version ${String(p.version)}; this CrewPoppy reads up to version ${PACK_VERSION}. Update CrewPoppy first.` };
  }
  const agents = objects(p.agents);
  const notes = objects(p.notes);
  const files = objects(p.files);
  if (agents.length > PACK_MAX_AGENTS) return { error: `That pack holds ${agents.length} agents — the most a crew can take is ${PACK_MAX_AGENTS}.` };
  if (notes.length + files.length > PACK_MAX_ITEMS) return { error: `That pack holds ${notes.length + files.length} notes and files — more than ${PACK_MAX_ITEMS}.` };
  const omitted = Array.isArray(p.omitted) ? p.omitted.filter((x): x is string => typeof x === "string").slice(0, 200) : undefined;
  return {
    pack: {
      format: PACK_FORMAT,
      version: p.version,
      exportedAt: typeof p.exportedAt === "string" ? p.exportedAt : "",
      edition: p.edition === "google" ? "google" : "aws",
      poppy: typeof p.poppy === "string" ? p.poppy : "",
      agents: agents as unknown as PackAgent[],
      notes: notes as unknown as PackNote[],
      files: files as unknown as PackFile[],
      ...(omitted && omitted.length > 0 ? { omitted } : {}),
    },
  };
}
