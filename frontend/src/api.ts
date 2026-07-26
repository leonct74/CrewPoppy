// Calls to our own backend, proxied by the host (capability: backend:invoke). The
// frontend has no AWS SDK, no Node and no network of its own — everything privileged
// goes through the bridge.

import { host } from "./host";
import type {
  AgentSummary, DeploymentStatus, Meta, ModelAccess, ModelCatalogue, RunRecord, TranscriptEntry,
} from "./types";

export const api = {
  meta: (): Promise<Meta> => host.invokeBackend({ method: "GET", path: "/meta" }),

  /** Can this account run Claude yet? Read-only and token-free. */
  modelAccess: (): Promise<ModelAccess> => host.invokeBackend({ method: "GET", path: "/model-access" }),

  /** The curated model shortlist with each one's live status for this account. */
  models: (): Promise<ModelCatalogue> => host.invokeBackend({ method: "GET", path: "/models" }),

  /** The live deployment state, read from CloudFormation on every call. */
  status: (): Promise<DeploymentStatus> => host.invokeBackend({ method: "GET", path: "/status" }),

  /** Kicks off the deploy; AWS carries on with it in the background. */
  deploy: (): Promise<{ operation: string; stackName: string }> =>
    host.invokeBackend({ method: "POST", path: "/deploy" }),

  // ---- agents (P1) --------------------------------------------------------
  listAgents: (): Promise<{ agents: AgentSummary[] }> =>
    host.invokeBackend({ method: "GET", path: "/agents" }),

  saveAgent: (body: Record<string, unknown>): Promise<AgentSummary> =>
    host.invokeBackend({ method: "POST", path: "/agents", body }),

  deleteAgent: (id: string): Promise<{ ok: true }> =>
    host.invokeBackend({ method: "DELETE", path: `/agents/${id}` }),

  /** Starts a run; the Lambda carries on in the user's account regardless of the UI. */
  startRun: (id: string, input: string): Promise<RunRecord> =>
    host.invokeBackend({ method: "POST", path: `/agents/${id}/runs`, body: { input } }),

  listRuns: (id: string): Promise<{ runs: RunRecord[] }> =>
    host.invokeBackend({ method: "GET", path: `/agents/${id}/runs` }),

  getRun: (id: string, runId: string): Promise<{ run: RunRecord; transcript: TranscriptEntry[] }> =>
    host.invokeBackend({ method: "GET", path: `/agents/${id}/runs/${runId}` }),

  /** Removes everything CrewPoppy created. Waits for AWS to finish. */
  teardown: (): Promise<{ ok: true; removed: string[] }> =>
    host.invokeBackend({ method: "POST", path: "/teardown" }, 15 * 60_000),
};
