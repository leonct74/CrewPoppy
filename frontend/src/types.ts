// The shapes the backend returns. Mirrors backend/src/stack.ts — the sidecar is a
// separate process, so this is a wire contract, not a shared type.

export type DeploymentPhase = "none" | "deploying" | "ready" | "removing" | "failed";

export interface DeploymentStatus {
  phase: DeploymentPhase;
  /** Raw CloudFormation status — for the technical details disclosure only. */
  stackStatus?: string;
  stackName: string;
  region: string;
  tableName?: string;
  runnerFunctionName?: string;
  /** AWS is still working: keep polling (AGENTS.md §5). */
  inProgress: boolean;
  /** One calm sentence, already written for the user by the backend. */
  message?: string;
  /** The raw CloudFormation reason for a failure — shown in Technical details. */
  failureReason?: string;
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  /** The agent-runner code deployed, vs. what this build ships — versioned separately. */
  deployedLambdaKey?: string;
  currentLambdaKey?: string;
  updateAvailable: boolean;
}

export interface Meta {
  account: { accountId: string; region: string };
  connectionId: string;
}

/** One curated model, answered against this account (DESIGN §2c). */
export interface ModelChoice {
  id: string;
  label: string;
  provider: string;
  goodAt: string;
  toolUse: boolean;
  vision: boolean;
  /** Relative running cost against the others here — not an absolute price. */
  cost: "$" | "$$" | "$$$";
  /** Hint only; `ready` is the authoritative answer. */
  formLikely: boolean;
  ready: boolean;
  /** False when CrewPoppy's engine can't drive this model yet — our gap, not yours. */
  supported?: boolean;
  /** Ready because a run actually succeeded on it, not because AWS says so. */
  proven?: boolean;
  unknown?: boolean;
}

export interface ModelCatalogue {
  models: ModelChoice[];
  consoleUrl?: string;
}

/** Whether this AWS account may actually invoke Claude yet (DESIGN §2c). */
export interface ModelAccess {
  ready: boolean;
  modelId: string;
  /** Raw AWS status strings — technical details only. */
  agreement?: string;
  authorization?: string;
  entitlement?: string;
  regionAvailability?: string;
  /** One calm sentence, already written for the user by the backend. */
  message?: string;
  /** We genuinely couldn't tell — say so rather than claim it's fine. */
  unknown?: boolean;
  /** Where the owner completes the one-time form. */
  consoleUrl?: string;
}

// ---- agents (P1) ----------------------------------------------------------
// Mirrors @crewpoppy/shared — the sidecar is a separate process, so this is a wire
// contract rather than a shared type.

export interface AgentCaps {
  maxIterations: number;
  maxTokensPerRun: number;
  maxWallClockMs: number;
  monthlySpendCapUsd: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  instructions: string;
  modelId: string;
  tools: string[];
  /** The verified address this agent sends from, if it has one of its own. */
  emailFrom?: string;
  /** May anyone start this agent by emailing it, or only the owner (the default)? */
  openInbox?: boolean;
  schedule?: AgentSchedule;
  /** When it next fires, computed by the ticker's own code. */
  nextRunAt?: string;
  caps: AgentCaps;
  createdAt: string;
  updatedAt: string;
  /** Spent this calendar month, against caps.monthlySpendCapUsd. */
  monthSpendUsd: number;
}

export interface RunRecord {
  runId: string;
  agentId: string;
  status: "running" | "waiting" | "succeeded" | "failed" | "stopped";
  stopReason?: string;
  input: string;
  output?: string;
  cost: { usage: { inputTokens: number; outputTokens: number }; usd?: number; approx?: boolean };
  iterations: number;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  modelId: string;
}

export interface RunView {
  run: RunRecord;
  transcript: TranscriptEntry[];
  /** Present when the run is waiting on a proposed action rather than a question. */
  pending?: PendingSend;
}

export interface TranscriptEntry {
  seq: number;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
}

/** What deleting an agent actually removed — reported, not assumed. */
export interface DeleteResult {
  ok: boolean;
  removed?: { runs: number; memories: number; files: number };
}

/** One switchable tool, with the plain-language note shown beside its checkbox. */
export interface ToolOption {
  name: string;
  label: string;
  what: string;
  risk?: string;
}

/** Capabilities are approved as a SET at creation, grouped the way owners ask. */
export interface ToolGroup {
  key: string;
  label: string;
  what: string;
  tools: string[];
}

/** Something people expect an agent to do, that it can't. Shown greyed out. */
export interface ComingCapability {
  key: string;
  label: string;
  what: string;
  why: string;
  group: string;
}

export interface ToolCatalogue {
  tools: ToolOption[];
  groups: ToolGroup[];
  /** Tools that do nothing until an email address is set for this install. */
  needsEmail: string[];
  coming?: ComingCapability[];
}

/** When an agent runs itself (DESIGN §5b). Data on the agent, not an AWS resource. */
export interface AgentSchedule {
  kind: "hourly" | "daily" | "weekly";
  hour: number;
  minute: number;
  weekday: number;
  timezone: string;
  task: string;
  enabled: boolean;
}

/** One file an agent wrote into its workspace. */
export interface WorkspaceFile {
  path: string;
  size: number;
  modified?: string;
}

/** What a schedule means, answered by the backend so the UI never does its own maths. */
export interface SchedulePreview {
  schedule?: AgentSchedule;
  description?: string;
  nextRunAt?: string;
}

/** Whether AWS is actually waking CrewPoppy to check schedules (DESIGN §5b). */
export interface TickerHealth {
  at?: string;
  agents?: number;
  scheduled?: number;
  due?: number;
  started?: number;
  healthy: boolean;
  everRan: boolean;
}

/** The one address agents email you at (DESIGN §4c). */
export interface OwnerEmail {
  email?: string;
  verified?: boolean;
  message?: string;
}

/** An email an agent has proposed and is waiting for you to approve. */
export interface PendingSend {
  kind: "send_email";
  to: string;
  subject: string;
  body: string;
  /** Workspace file that will be attached — openable from the approval card. */
  attach?: string;
}
