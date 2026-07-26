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
  caps: AgentCaps;
  createdAt: string;
  updatedAt: string;
  /** Spent this calendar month, against caps.monthlySpendCapUsd. */
  monthSpendUsd: number;
}

export interface RunRecord {
  runId: string;
  agentId: string;
  status: "running" | "succeeded" | "failed" | "stopped";
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

export interface TranscriptEntry {
  seq: number;
  role: "user" | "assistant" | "system";
  text: string;
}
