// Minimal host-bridge client (inlined — the AgentsPoppy SDK isn't published to npm,
// so like MailPoppy we mirror the tiny wire contract instead of taking a cross-repo
// build dependency). Protocol mirrors @agentspoppy/extension-sdk bridge.ts exactly:
// post { id, method, params } to the parent; await { id, ok, result | error }.

export type AccessState = "granted" | "pending" | "denied";

export interface BackendInvoke {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}

interface HostRequest {
  id: string;
  method: string;
  params: unknown[];
}
type HostResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const res = e.data as HostResponse;
  if (!res || typeof (res as { id?: unknown }).id !== "string" || !("ok" in res)) return;
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  clearTimeout(p.timer);
  if (res.ok) p.resolve(res.result);
  else p.reject(new Error(res.error));
});

function call<T>(method: string, params: unknown[], timeoutMs = 120_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    seq += 1;
    const id = `req-${Date.now().toString(36)}-${seq}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`AgentsPoppy didn't respond in time (${method}).`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    const req: HostRequest = { id, method, params };
    window.parent.postMessage(req, "*");
  });
}

export const host = {
  ensureAccess: (): Promise<AccessState> => call("ensureAccess", []),
  getConnection: (): Promise<{ id: string; status: string; app?: { id: string; name: string } }> =>
    call("getConnection", []),
  /** `timeoutMs` overrides the 2-minute default for calls that legitimately run long
   *  (teardown waits for CloudFormation to finish deleting). */
  invokeBackend: <T = unknown>(request: BackendInvoke, timeoutMs?: number): Promise<T> =>
    call("invokeBackend", [request], timeoutMs),
  openExternal: (url: string): Promise<void> => call("openExternal", [url]),
  notify: (n: { title: string; body?: string }): Promise<void> => call("notify", [n]),
  /**
   * Feedback (capability `feedback:submit`) — what the mandatory Feedback tab submits. The host
   * answers using the same anonymous per-install id it uses for purchases, so none of this needs
   * an account and we never learn who rated us. The vendored `<agentspoppy-feedback>` element
   * takes this object directly; these four methods are the shape it expects.
   */
  ratingInfo: (): Promise<RatingInfo> => call("ratingInfo", []),
  rate: (stars: number): Promise<RatingInfo> => call("rate", [stars]),
  sendFeatureRequest: (text: string): Promise<void> => call("sendFeatureRequest", [text]),
  donate: (amountUsd: number, message?: string): Promise<void> =>
    call("donate", message === undefined ? [amountUsd] : [amountUsd, message]),
};

export interface RatingInfo {
  average: number;
  count: number;
  yours: number | null;
}
