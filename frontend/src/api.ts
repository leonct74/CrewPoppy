// Calls to our own backend, proxied by the host (capability: backend:invoke). The
// frontend has no AWS SDK, no Node and no network of its own — everything privileged
// goes through the bridge.

import { host, type BackendInvoke } from "./host";
import type {
  AgentSummary, DeleteResult, DeploymentStatus, Meta, ModelAccess, ModelCatalogue, OwnerEmail,
  RunRecord, RunView, SchedulePreview, TickerHealth, ToolCatalogue, WorkspaceFile,
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

  /** The switchable capabilities, grouped as the create form asks them. */
  listTools: (): Promise<ToolCatalogue> => invoke({ method: "GET", path: "/tools" }),

  /**
   * What a candidate schedule actually means, answered by the ticker's own code. Asked
   * before saving so "next run" is a fact rather than the UI's own arithmetic.
   */
  previewSchedule: (schedule: unknown): Promise<SchedulePreview> =>
    invoke({ method: "POST", path: "/schedule-preview", body: { schedule } }),

  /** Is AWS actually waking CrewPoppy to check schedules? */
  ticker: (): Promise<TickerHealth> => invoke({ method: "GET", path: "/ticker" }),

  /** MailPoppy mailboxes assigned to agents — the editor's address choices. */
  agentMailboxes: (): Promise<{ mailboxes: string[] }> =>
    invoke({ method: "GET", path: "/agent-mailboxes" }),

  /** The one address agents email you at. Re-checked against SES on every read. */
  ownerEmail: (): Promise<OwnerEmail> => invoke({ method: "GET", path: "/owner-email" }),

  /** Save it — refused unless AWS will actually send from it. "" clears it. */
  setOwnerEmail: (email: string): Promise<OwnerEmail> =>
    invoke({ method: "PUT", path: "/owner-email", body: { email } }),

  /** Will AWS send from this address? Asked before an agent is given one of its own. */
  verifySender: (email: string): Promise<{ email: string; verified: boolean }> =>
    invoke({ method: "GET", path: `/verify-sender?email=${encodeURIComponent(email)}` }),

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

  /**
   * Answer a waiting run (DESIGN §5). `approved` is the Approve BUTTON and nothing else:
   * a proposed email is sent only when the owner said yes to that exact message, never
   * because their typed words sounded like agreement (DESIGN §4c).
   */
  answerRun: (id: string, runId: string, answer: string, approved?: boolean): Promise<RunRecord> =>
    invoke({
      method: "POST",
      path: `/agents/${id}/runs/${runId}/answer`,
      body: { answer, ...(approved ? { approved: true } : {}) },
    }),

  /** The files this agent has written — the owner's window into its workspace. */
  listFiles: (id: string): Promise<{ files: WorkspaceFile[] }> =>
    invoke({ method: "GET", path: `/agents/${id}/files` }),

  readFile: (id: string, path: string): Promise<{ path: string; content: string }> =>
    invoke({ method: "GET", path: `/agents/${id}/files?path=${encodeURIComponent(path)}` }),

  /** Save a text file INTO the agent's workspace — templates, reference material. */
  putFile: (id: string, path: string, content: string): Promise<{ ok: true }> =>
    invoke({ method: "PUT", path: `/agents/${id}/files`, body: { path, content } }),

  /** Remove one file from the agent's folder. Already-gone is a success. */
  deleteFile: (id: string, path: string): Promise<{ ok: true }> =>
    invoke({ method: "DELETE", path: `/agents/${id}/files?path=${encodeURIComponent(path)}` }),

  /** A five-minute signed link to one file — how a PDF reaches the owner's browser. */
  fileLink: (id: string, path: string): Promise<{ url: string }> =>
    invoke({ method: "GET", path: `/agents/${id}/file-link?path=${encodeURIComponent(path)}` }),

  /** Wipe the conversation: runs + transcripts. Memory, files and spend stay. */
  clearHistory: (id: string): Promise<{ ok: true }> =>
    invoke({ method: "DELETE", path: `/agents/${id}/history` }),

  /** The kill switch (DESIGN §7). */
  stopRun: (id: string, runId: string): Promise<RunRecord> =>
    invoke({ method: "POST", path: `/agents/${id}/runs/${runId}/stop` }),

  getRun: (id: string, runId: string): Promise<RunView> =>
    invoke({ method: "GET", path: `/agents/${id}/runs/${runId}` }),

  /** Removes everything CrewPoppy created. Waits for AWS to finish. */
  teardown: (): Promise<{ ok: true; removed: string[] }> =>
    invoke({ method: "POST", path: "/teardown" }, 15 * 60_000),

  // ---- the phone (DESIGN §15h M1) ------------------------------------------
  /** Is the mobile door deployed, does a phone login exist, has it turned push on? */
  mobileStatus: (): Promise<{ doorReady: boolean; paired: boolean; pushEnabled?: boolean }> =>
    invoke({ method: "GET", path: "/mobile" }),

  /**
   * Mint (or re-key) the one phone login and get the QR payload. The password inside
   * exists only in this response and in Cognito — nothing stores it, so the QR must be
   * scanned while it's on screen. Pairing again always invalidates the previous code.
   */
  mobilePair: (): Promise<{ ok: true; payload: PairingPayload }> =>
    invoke({ method: "POST", path: "/mobile/pair" }),

  /** Sign the phone out for good — deletes the login. Re-pairing recreates it. */
  mobileRevoke: (): Promise<{ ok: boolean }> =>
    invoke({ method: "POST", path: "/mobile/revoke" }),
};

/** What the pairing QR encodes (backend/src/mobile.ts is the source of truth). */
export interface PairingPayload {
  kind: "crewpoppy-pair";
  v: 1;
  region: string;
  poolId: string;
  clientId: string;
  apiUrl: string;
  username: string;
  password: string;
}
