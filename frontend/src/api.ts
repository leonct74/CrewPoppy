// Calls to our own backend, proxied by the host (capability: backend:invoke). The
// frontend has no AWS SDK, no Node and no network of its own — everything privileged
// goes through the bridge.

import { host, type BackendInvoke } from "./host";
import type {
  AgentSummary, DeleteResult, DeploymentStatus, Meta, ModelAccess, ModelCatalogue, RunRecord,
  ToolOption, TranscriptEntry,
} from "./types";

/**
 * The host reports a non-2xx backend reply as `backend 409: {"error":"…"}`. The sentence
 * inside was written for the user; the wrapper around it was not. Pull the sentence out,
 * so a refusal reads like a refusal instead of like a stack trace.
 */
export function plainMessage(raw: string): string {
  const body = /^backend \d{3}:\s*([\s\S]*)$/.exec(raw)?.[1] ?? raw;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
  } catch {
    /* not JSON — whatever we have is the best we can show */
  }
  return raw;
}

function invoke<T>(request: BackendInvoke, timeoutMs?: number): Promise<T> {
  return host.invokeBackend<T>(request, timeoutMs).catch((e: unknown) => {
    throw new Error(plainMessage((e as Error).message));
  });
}

export const api = {
  meta: (): Promise<Meta> => invoke({ method: "GET", path: "/meta" }),

  /** Can this account run Claude yet? Read-only and token-free. */
  modelAccess: (): Promise<ModelAccess> => invoke({ method: "GET", path: "/model-access" }),

  /** The curated model shortlist with each one's live status for this account. */
  models: (): Promise<ModelCatalogue> => invoke({ method: "GET", path: "/models" }),

  /** The live deployment state, read from CloudFormation on every call. */
  status: (): Promise<DeploymentStatus> => invoke({ method: "GET", path: "/status" }),

  /** Kicks off the deploy; AWS carries on with it in the background. */
  deploy: (): Promise<{ operation: string; stackName: string }> =>
    invoke({ method: "POST", path: "/deploy" }),

  /** The switchable tools, with the note shown beside each checkbox. */
  listTools: (): Promise<{ tools: ToolOption[] }> => invoke({ method: "GET", path: "/tools" }),

  // ---- agents (P1) --------------------------------------------------------
  listAgents: (): Promise<{ agents: AgentSummary[] }> =>
    invoke({ method: "GET", path: "/agents" }),

  saveAgent: (body: Record<string, unknown>): Promise<AgentSummary> =>
    invoke({ method: "POST", path: "/agents", body }),

  /** Deletes the agent AND everything only it owned. Refuses while a run is live. */
  deleteAgent: (id: string): Promise<DeleteResult> =>
    invoke({ method: "DELETE", path: `/agents/${id}` }),

  /** Starts a run; the Lambda carries on in the user's account regardless of the UI. */
  startRun: (id: string, input: string): Promise<RunRecord> =>
    invoke({ method: "POST", path: `/agents/${id}/runs`, body: { input } }),

  listRuns: (id: string): Promise<{ runs: RunRecord[] }> =>
    invoke({ method: "GET", path: `/agents/${id}/runs` }),

  /** Answer a run waiting on ask_user, so it carries on (DESIGN §5). */
  answerRun: (id: string, runId: string, answer: string): Promise<RunRecord> =>
    invoke({ method: "POST", path: `/agents/${id}/runs/${runId}/answer`, body: { answer } }),

  /** The kill switch (DESIGN §7). */
  stopRun: (id: string, runId: string): Promise<RunRecord> =>
    invoke({ method: "POST", path: `/agents/${id}/runs/${runId}/stop` }),

  getRun: (id: string, runId: string): Promise<{ run: RunRecord; transcript: TranscriptEntry[] }> =>
    invoke({ method: "GET", path: `/agents/${id}/runs/${runId}` }),

  /** Removes everything CrewPoppy created. Waits for AWS to finish. */
  teardown: (): Promise<{ ok: true; removed: string[] }> =>
    invoke({ method: "POST", path: "/teardown" }, 15 * 60_000),
};
