// The agent-runner Lambda — P0 walking skeleton.
//
// At P1 this becomes the agentic loop (DESIGN.md §5): load the agent definition, call
// Bedrock with the persona + instructions, enforce every §7 guardrail IN the loop
// (max iterations / tokens / wall-clock / spend), persist the transcript, and
// checkpoint-and-exit on ask_user. At P0 it exists so the deploy pipeline, the
// execution role, the log group and the teardown all carry a real Lambda end-to-end.
//
// Safety invariant that starts here and never changes (DESIGN.md §4): this function's
// execution role is the ONLY set of AWS permissions anywhere near an agent, and the
// agent itself never sees these credentials — it emits tool calls, the trusted
// dispatcher executes them, per-agent scoped.

export interface RunnerEvent {
  /** P1: the run to execute. Unused in the walking skeleton. */
  runId?: string;
}

export interface RunnerResult {
  ok: boolean;
  skeleton: true;
  message: string;
}

export async function handler(_event: RunnerEvent): Promise<RunnerResult> {
  return {
    ok: true,
    skeleton: true,
    message: "CrewPoppy agent-runner walking skeleton — the P1 agentic loop lands here.",
  };
}
