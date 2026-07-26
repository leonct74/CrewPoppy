// The shapes that cross the boundary between the sidecar (control plane, on the user's
// machine) and the agent-runner Lambda (execution, in the user's AWS). Both bundle this
// module, so the wire contract can't drift between them.

/** Safe defaults — never unlimited (DESIGN §7, §14.6). Every agent starts capped. */
export const DEFAULT_CAPS: AgentCaps = {
  maxIterations: 8,
  maxTokensPerRun: 20_000,
  maxWallClockMs: 120_000,
  monthlySpendCapUsd: 10,
};

/**
 * The hard limits the runner enforces IN the loop (DESIGN §7). These are mechanisms,
 * not advice: a run that would breach one refuses to start, and a run that breaches one
 * mid-flight stops cleanly and records why.
 */
export interface AgentCaps {
  /** Model round-trips per run. */
  maxIterations: number;
  /** Total tokens (input + output) per run. */
  maxTokensPerRun: number;
  /** Wall-clock per run, in ms. */
  maxWallClockMs: number;
  /** Dollars this agent may spend across a calendar month. */
  monthlySpendCapUsd: number;
}

/**
 * An agent is stored data, not code (DESIGN §3) — which is what makes a crew portable
 * and essentially free until it runs.
 */
export interface AgentDef {
  id: string;
  /** Given name, so the crew feels like a team: "Emma". */
  name: string;
  /** Owner-assigned, freeform: "Research Assistant". */
  role: string;
  /** The system prompt — the brief. */
  instructions: string;
  /** A bare foundation-model id from the catalogue. */
  modelId: string;
  /**
   * Which tools this agent may use — the per-agent allowlist the dispatcher enforces
   * (DESIGN §4). Empty means the agent can only read its task and answer, which is the
   * safe default for a new agent.
   */
  tools: string[];
  caps: AgentCaps;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "running" | "succeeded" | "failed" | "stopped";

/** Why a run ended early. Recorded so the user always learns which limit bit. */
export type StopReason =
  | "completed"
  | "max_iterations"
  | "max_tokens"
  | "max_wall_clock"
  | "monthly_spend_cap"
  | "error";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunCost {
  usage: TokenUsage;
  /** Undefined when we have no verified rate for this model — never a guessed number. */
  usd?: number;
  /** True when `usd` comes from a rate table rather than a live price query. */
  approx?: boolean;
}

export interface TranscriptEntry {
  seq: number;
  role: "user" | "assistant" | "system";
  text: string;
}

export interface RunRecord {
  runId: string;
  agentId: string;
  status: RunStatus;
  stopReason?: StopReason;
  /** The task the owner gave this run. */
  input: string;
  /** The agent's answer, once it has one. */
  output?: string;
  cost: RunCost;
  iterations: number;
  startedAt: string;
  finishedAt?: string;
  /** One calm sentence when something went wrong. */
  message?: string;
  modelId: string;
}

/** What the sidecar sends the Lambda to start a run. */
export interface RunnerEvent {
  runId: string;
  agentId: string;
  input: string;
  tableName: string;
}
