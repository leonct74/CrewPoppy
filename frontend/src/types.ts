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
