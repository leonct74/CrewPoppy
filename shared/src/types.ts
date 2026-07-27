// The shapes that cross the boundary between the sidecar (control plane, on the user's
// machine) and the agent-runner Lambda (execution, in the user's AWS). Both bundle this
// module, so the wire contract can't drift between them.

import type { AgentSchedule } from "./schedule";

/** Safe defaults — never unlimited (DESIGN §7, §14.6). Every agent starts capped. */
export const DEFAULT_CAPS: AgentCaps = {
  maxIterations: 8,
  maxTokensPerRun: 20_000,
  maxWallClockMs: 120_000,
  monthlySpendCapUsd: 10,
};

/**
 * The hard ceiling on messages one agent can send in a day (DESIGN §4c). A cap, not a
 * quota to plan around: an approved workflow that misfires stops here rather than
 * emptying itself into someone's inbox.
 */
export const MAX_EMAILS_PER_DAY = 50;

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
  /**
   * The address this agent sends FROM, when it has one of its own ("does Emma have an
   * email?"). Must already be verified in the owner's account — CrewPoppy never creates
   * mail identities, that's MailPoppy's job. Unset means it sends from the install's
   * own address.
   */
  emailFrom?: string;
  /**
   * When this agent runs itself (DESIGN §5b). Data on the agent, not an AWS resource:
   * one ticker serves the whole install, so changing a schedule provisions nothing and
   * leaves nothing behind.
   */
  schedule?: AgentSchedule;
  caps: AgentCaps;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "stopped";

/** Why a run ended early. Recorded so the user always learns which limit bit. */
export type StopReason =
  | "completed"
  | "max_iterations"
  | "max_tokens"
  | "max_wall_clock"
  | "monthly_spend_cap"
  | "waiting_for_you"
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
  /** "tool" entries are the audit trail: which tool ran, and what came back (DESIGN §9). */
  role: "user" | "assistant" | "system" | "tool";
  text: string;
}

/**
 * An action the agent PROPOSED and the owner has not yet approved (DESIGN §4c).
 *
 * Stored on the checkpoint verbatim, and executed from HERE — never from whatever the
 * model says after the owner answers. That is the whole point: you approve a specific
 * message to a specific person, so that is the only thing that can be sent. A model that
 * changes the address or the words after approval has changed nothing that matters.
 */
export interface PendingSend {
  kind: "send_email";
  to: string;
  subject: string;
  body: string;
}

/**
 * A suspended run (DESIGN §5). A Lambda cannot block for hours waiting on a human, so
 * `ask_user` writes the WHOLE conversation here and exits; answering resumes from this
 * and nothing else. The checkpoint is the entire truth — which is what makes resuming
 * safe: earlier tool calls are never replayed, they are already in `messages`.
 */
export interface RunCheckpoint {
  runId: string;
  agentId: string;
  question: string;
  draft?: string;
  /** Set when the run paused on a proposed send rather than a plain question. */
  pending?: PendingSend;
  /** The full Anthropic-format conversation so far. */
  messages: unknown[];
  usage: TokenUsage;
  iterations: number;
  startedAt: string;
  /** Where the transcript got to, so resuming continues rather than overwriting. */
  nextSeq: number;
  /** Unix seconds; DynamoDB expires the row, and the code checks it too. */
  expiresAt: number;
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

/** What the sidecar sends the Lambda to start — or resume — a run. */
export interface RunnerEvent {
  runId: string;
  agentId: string;
  input: string;
  tableName: string;
  /**
   * Present only when resuming a run that was waiting on `ask_user`. The run continues
   * from its checkpoint with this appended — it never re-executes what already happened.
   */
  answer?: string;
  /**
   * True ONLY when the owner pressed Approve on a proposed action. Never inferred from
   * the words they typed: "yes, but change the greeting" is a new message that needs
   * approving in its own right, not consent to the one on screen.
   */
  approved?: boolean;
}

/** How long a phone-approval link, and the waiting run behind it, stay valid. */
export const CHECKPOINT_TTL_SECONDS = 7 * 24 * 60 * 60;
