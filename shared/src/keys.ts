// DynamoDB key construction — single-table design (DESIGN §2b).
//
// IDEMPOTENCY RULE (the family lesson, CLAUDE.md gotcha #3): every key is a
// DETERMINISTIC function of ids the caller already holds. `new Date()` is NEVER a
// sort-key fallback — a re-run would then write a SECOND row instead of overwriting the
// first, which is precisely what would break `ask_user` resume at P2.
//
// Layout (pk / sk):
//   agents            / agent#<agentId>    the agent definition — Query "agents" lists the crew
//   agent#<agentId>   / run#<runId>        one run of that agent — Query lists its history
//   run#<runId>       / msg#000001…        the transcript, ordered by zero-padded sequence
//   spend#<agentId>   / month#YYYY-MM      the monthly spend counter (atomic ADD target)

/** Partition holding every agent definition, so the crew lists with one Query. */
export const AGENTS_PK = "agents";
export const agentSk = (agentId: string) => `agent#${agentId}`;

export const agentPk = (agentId: string) => `agent#${agentId}`;
export const runSk = (runId: string) => `run#${runId}`;

export const transcriptPk = (runId: string) => `run#${runId}`;
/** Zero-padded so lexical sort is numeric order. */
export const transcriptSk = (seq: number) => `msg#${String(seq).padStart(6, "0")}`;

/**
 * Ground truth: a model that has actually completed a run in THIS account works, whatever
 * the model-agreement status field says (it lags, sometimes for a long time). The runner
 * stamps this on success; the catalogue trusts it over the status field.
 * Deterministic key — re-proving overwrites rather than accumulating rows.
 */
export const provenPk = (modelId: string) => `model#${modelId}`;
export const PROVEN_SK = "proven";

/** A suspended run's checkpoint — one per run, so resuming overwrites rather than forks. */
export const checkpointPk = (runId: string) => `checkpoint#${runId}`;
export const CHECKPOINT_SK = "state";

/** Per-agent, per-month spend counter — an atomic ADD target, not read-modify-write. */
export const spendPk = (agentId: string) => `spend#${agentId}`;
export const spendSk = (monthKey: string) => `month#${monthKey}`;

/**
 * Install-level settings the RUNNER must read at execution time — not baked into the
 * Lambda's environment, so changing where approval mail goes doesn't need a redeploy.
 */
export const CONFIG_PK = "config";
export const OWNER_EMAIL_SK = "owner-email";

/**
 * The ticker's heartbeat (DESIGN §5b). Written on EVERY tick, whether or not anything was
 * due.
 *
 * Added after four rounds of debugging a schedule that never fired, where neither the
 * founder nor I could tell "EventBridge isn't calling us" from "it's calling us and no
 * agent matched". Those need completely different fixes and looked identical on screen.
 * A row that says "I ran at 21:05 and checked 2 agents, 0 due" separates them instantly.
 */
export const LAST_TICK_SK = "last-tick";

/**
 * Per-agent, per-DAY email counter. The same atomic-ADD shape as spend, for the same
 * reason: an approved workflow that goes wrong must hit a hard ceiling rather than a
 * polite intention (DESIGN §7 — caps are mechanisms, never advice).
 */
export const sendCountPk = (agentId: string) => `sends#${agentId}`;
export const sendCountSk = (dayKey: string) => `day#${dayKey}`;
