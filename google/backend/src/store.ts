// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0

/**
 * The crew's own records, in Firestore inside the poppy's own project (DESIGN.md §18 — Firestore
 * for DynamoDB): `briefs`, `agents`, `runs`, `spend`, and since G3c the agents' own `notes` and
 * `files`. `open()` brings the database up on the first run and never throws — the page shows
 * the state, and the routes that need the store answer 503 until it is ready.
 */
import type { AgentDef } from "./agents";
import type { FirestoreWire } from "./firestore";
import { GoogleError } from "./google";
import type { Step } from "./loop";
import { fileIdFor, noteIdFor } from "./tools";

export const BRIEFS = "briefs";
export const META = "meta";
export const SPEND = "spend";
export const RUNS = "runs";
export const AGENTS = "agents";
export const NOTES = "notes";
export const FILES = "files";
export const SCHEMA_VERSION = 1;

export interface BriefRecord {
  id: string;
  at: string;
  purpose: string;
  /** The brief, as shown. */
  text: string;
  /** What it was made from — memory ids, so the page can say exactly what was read. */
  memoryIds: string[];
  /** The receipts' ids on the connection's Activity — the reads this brief caused. */
  receipts: string[];
  /** How many of what were read. */
  read: { events: number; people: number; bytes: number };
  /** Who wrote the words: the model, or the Briefer's own template. */
  writtenBy: "model" | "template";
  /** When the model wrote it: which, and what it cost in tokens — and at most in dollars, at the ceiling. */
  model?: { name: string; words: string; promptTokens: number; outputTokens: number; ceilingUsd: number };
  /** Why the template wrote it although a model was there: a cap, or a refusal, in the user's words. */
  note?: string;
}

export interface Settings {
  /** Whether the crew writes with the model (default: yes, when the build has one). */
  model?: boolean;
}

export type RunStatus = "running" | "succeeded" | "stopped" | "waiting";

/** One request answered by the crew — the Planner's choice, the reads, the answer, the cost. */
export interface RunRecord {
  id: string;
  at: string;
  /** The crew member that answered: "assistant" for tasks on the fly. */
  agent: string;
  /** Its name at the time, so the page can say "Nico" without looking it up. */
  agentName?: string;
  request: string;
  /** The Planner's tier and its one-line reason. */
  tier: "none" | "light" | "standard" | "deep";
  why: string;
  /** Whether the user overruled the Planner. */
  choice: "auto" | "quick" | "standard" | "best";
  answer: string;
  /** What was read from the memory, and the receipts it left. */
  read: { count: number; bytes: number; receipts: string[]; purpose: string };
  model?: { name: string; words: string; promptTokens: number; outputTokens: number; ceilingUsd: number };
  /** When the answer did not come the planned way: a cap, a refusal — in the user's words. */
  note?: string;
  /** Absent on a run from before the loop (G3c): those succeeded. */
  status?: RunStatus;
  /** How the run started: asked on the fly, pressed on the agent, or its schedule. */
  trigger?: "ask" | "run" | "schedule";
  /** Where it ran: in the app on the user's machine, or in the cloud while the app was closed (G4). */
  via?: "app" | "cloud";
  /** The schedule's slot this run was for — the run id is derived from it, so a slot runs once. */
  slot?: string;
  /** The words when the schedule's slot was run late — the app was closed at the time. */
  late?: string;
  /** What the agent did, step by step — every tool call, every result, nothing hidden. */
  steps?: Step[];
  iterations?: number;
  toolsUsed?: string[];
  /** While the run waits for the user: the question, and the conversation to resume (JSON). */
  question?: { question: string; draft?: string };
  conversation?: string;
  answeredAt?: string;
  /** When the small model was asked which tier: its word and its cost. */
  judge?: { tier: "light" | "standard" | "deep"; promptTokens: number; outputTokens: number; ceilingUsd: number };
}

/** A note an agent keeps between runs — filed under the agent the runner named, never a name the model chose. */
export interface NoteRecord {
  agent: string;
  key: string;
  value: string;
  updatedAt: string;
}

/** A text file in an agent's own folder — the same scoping. */
export interface FileRecord {
  agent: string;
  path: string;
  content: string;
  updatedAt: string;
}

export type StoreState =
  | { state: "starting" }
  | { state: "setting-up"; step: string }
  | { state: "ready"; projectId: string; region: string; created: boolean }
  | { state: "failed"; message: string };

/** Firestore's two card-free multi-regions: Europe and Africa keep it in eur3, everyone else nam5. */
export function regionFor(timeZone: string): "eur3" | "nam5" {
  return /^(Europe|Africa|Atlantic)\//.test(timeZone) ? "eur3" : "nam5";
}

export interface CrewStoreDeps {
  wire: FirestoreWire;
  now?: () => string;
  timeZone?: () => string;
  log?: (line: string) => void;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CrewStore {
  private cloud: StoreState = { state: "starting" };
  private readonly now: () => string;
  private readonly timeZone: () => string;
  private readonly log: (line: string) => void;
  private readonly settleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: CrewStoreDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.timeZone = deps.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
    this.log = deps.log ?? (() => {});
    this.settleMs = deps.settleMs ?? 2 * 60 * 1000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  state(): StoreState {
    return this.cloud;
  }

  get ready(): boolean {
    return this.cloud.state === "ready";
  }

  unavailableMessage(): string {
    switch (this.cloud.state) {
      case "starting":
        return "CrewPoppy is starting";
      case "setting-up":
        return `CrewPoppy is setting up its Google Cloud project — ${this.cloud.step}. The first time takes about a minute.`;
      case "failed":
        return `CrewPoppy's own records are not reachable: ${this.cloud.message}`;
      default:
        return "CrewPoppy is ready";
    }
  }

  async open(): Promise<StoreState> {
    try {
      this.cloud = { state: "setting-up", step: "asking AgentsPoppy for the project's own token (the first time, this creates the project)" };
      const projectId = await this.deps.wire.projectId();
      const region = regionFor(this.timeZone());
      this.cloud = { state: "setting-up", step: `creating the database in ${region === "eur3" ? "Europe" : "the United States"}` };
      const db = await this.settling(() => this.deps.wire.ensureDatabase(region));
      const install = await this.deps.wire.get<{ region: string }>(META, "install");
      if (!install) await this.deps.wire.set(META, "install", { schema: SCHEMA_VERSION, region: db.locationId, createdAt: this.now(), app: "com.crewpoppy.cloud.google" });
      this.cloud = { state: "ready", projectId, region: db.locationId, created: db.created };
      this.log(`store ready — project ${projectId}, database ${db.locationId}${db.created ? " (created now)" : ""}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.cloud = { state: "failed", message };
      this.log(`store failed to open: ${message}`);
    }
    return this.cloud;
  }

  /** A fresh service account's 403 while IAM settles is retried; a disabled API is not. */
  private async settling<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.settleMs;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        const iamNotYet = e instanceof GoogleError && e.status === 403 && !/has not been used|is disabled|SERVICE_DISABLED/i.test(e.message);
        if (!iamNotYet || Date.now() >= deadline) throw e;
        this.cloud = { state: "setting-up", step: "waiting for Google to hand the project its permissions" };
        await this.sleep(5000);
      }
    }
  }

  private need(): FirestoreWire {
    if (!this.ready) throw new Error(this.unavailableMessage());
    return this.deps.wire;
  }

  async saveBrief(b: BriefRecord): Promise<void> {
    await this.need().set(BRIEFS, b.id, b);
  }

  async getMeta<T extends object>(id: string): Promise<T | null> {
    return this.need().get<T>(META, id);
  }

  async setMeta(id: string, value: object): Promise<void> {
    await this.need().set(META, id, value);
  }

  /** The month's counters — the caps' and the meter's one source of truth. */
  async spend<T extends object>(month: string): Promise<T | null> {
    return this.need().get<T>(SPEND, month);
  }

  async saveSpend(month: string, value: object): Promise<void> {
    await this.need().set(SPEND, month, value);
  }

  async agents(): Promise<AgentDef[]> {
    const all = await this.need().listChanged<AgentDef>(AGENTS, "createdAt", null);
    return all.map((d) => ({ ...d.data, id: d.id }));
  }

  async agent(id: string): Promise<AgentDef | null> {
    const a = await this.need().get<AgentDef>(AGENTS, id);
    return a ? { ...a, id } : null;
  }

  async saveAgent(a: AgentDef): Promise<void> {
    await this.need().set(AGENTS, a.id, a);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.need().delete(AGENTS, id);
  }

  /** An agent's notes and files go with it. */
  async deleteAgentData(id: string): Promise<void> {
    const wire = this.need();
    for (const n of await this.notes(id)) await wire.delete(NOTES, noteIdFor(id, n.key));
    for (const f of await this.files(id)) await wire.delete(FILES, fileIdFor(id, f.path));
  }

  async note(agentId: string, key: string): Promise<NoteRecord | null> {
    return this.need().get<NoteRecord>(NOTES, noteIdFor(agentId, key));
  }

  async saveNote(n: NoteRecord): Promise<void> {
    await this.need().set(NOTES, noteIdFor(n.agent, n.key), n);
  }

  async notes(agentId?: string): Promise<NoteRecord[]> {
    const all = await this.need().listChanged<NoteRecord>(NOTES, "updatedAt", null);
    return all.map((d) => d.data).filter((n) => !agentId || n.agent === agentId);
  }

  async file(agentId: string, path: string): Promise<FileRecord | null> {
    return this.need().get<FileRecord>(FILES, fileIdFor(agentId, path));
  }

  async saveFile(f: FileRecord): Promise<void> {
    await this.need().set(FILES, fileIdFor(f.agent, f.path), f);
  }

  async files(agentId?: string): Promise<FileRecord[]> {
    const all = await this.need().listChanged<FileRecord>(FILES, "updatedAt", null);
    return all
      .map((d) => d.data)
      .filter((f) => !agentId || f.agent === agentId)
      .sort((x, y) => x.path.localeCompare(y.path));
  }

  async saveRun(r: RunRecord): Promise<void> {
    await this.need().set(RUNS, r.id, r);
  }

  async run(id: string): Promise<RunRecord | null> {
    const r = await this.need().get<RunRecord>(RUNS, id);
    return r ? { ...r, id } : null;
  }

  /** Newest first. */
  async runs(limit = 30): Promise<RunRecord[]> {
    const all = await this.need().listChanged<RunRecord>(RUNS, "at", null);
    return all.map((d) => ({ ...d.data, id: d.id })).sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, limit);
  }

  /** The runs waiting for the user's answer, oldest first. */
  async waiting(): Promise<RunRecord[]> {
    const all = await this.runs(500);
    return all.filter((r) => r.status === "waiting").reverse();
  }

  /** An agent's run that is still going, or waiting — the reason a schedule never stacks up. */
  async activeRun(agentId: string): Promise<RunRecord | null> {
    const all = await this.runs(500);
    return all.find((r) => r.agent === agentId && (r.status === "running" || r.status === "waiting")) ?? null;
  }

  /** Newest first. */
  async briefs(limit = 20): Promise<BriefRecord[]> {
    const all = await this.need().listChanged<BriefRecord>(BRIEFS, "at", null);
    return all.map((d) => ({ ...d.data, id: d.id })).sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, limit);
  }
}
