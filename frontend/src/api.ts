// Calls to our own backend, proxied by the host (capability: backend:invoke). The
// frontend has no AWS SDK, no Node and no network of its own — everything privileged
// goes through the bridge.

import { host } from "./host";
import type { DeploymentStatus, Meta, ModelAccess } from "./types";

export const api = {
  meta: (): Promise<Meta> => host.invokeBackend({ method: "GET", path: "/meta" }),

  /** Can this account run Claude yet? Read-only and token-free. */
  modelAccess: (): Promise<ModelAccess> => host.invokeBackend({ method: "GET", path: "/model-access" }),

  /** The live deployment state, read from CloudFormation on every call. */
  status: (): Promise<DeploymentStatus> => host.invokeBackend({ method: "GET", path: "/status" }),

  /** Kicks off the deploy; AWS carries on with it in the background. */
  deploy: (): Promise<{ operation: string; stackName: string }> =>
    host.invokeBackend({ method: "POST", path: "/deploy" }),

  /** Removes everything CrewPoppy created. Waits for AWS to finish. */
  teardown: (): Promise<{ ok: true; removed: string[] }> =>
    host.invokeBackend({ method: "POST", path: "/teardown" }, 15 * 60_000),
};
