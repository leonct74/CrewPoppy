// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0
//
// Copied from memory-poppy/backend/src — the same dependency-free wire two poppies now share; it
// becomes a package the day a third one needs it. Edit there first, then copy.

/**
 * The poppy's own Google identity: a short-lived access token for the service account in ITS
 * project, minted by the host at `credentialsUrl` (SECURITY_MECHANISM.md §2.7 — the project is
 * the wall). Same contract the hello example spells out, re-minted five minutes before expiry,
 * concurrent asks coalesced. Plus the one way this backend speaks to Google's REST APIs: a fetch
 * that carries the token, retries the answers Google says to retry, and reports refusals in
 * Google's own words.
 */

export interface ProjectToken {
  accessToken: string;
  /** The poppy's OWN project — the only place the token means anything. */
  projectId: string;
  serviceAccount: string;
  /** ISO 8601. */
  expiration: string;
}

export type ProjectTokenProvider = () => Promise<ProjectToken>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TokenBootstrap {
  credentialsUrl: string;
  credentialsToken?: string;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export function createProjectTokenProvider(boot: TokenBootstrap, fetchFn: FetchLike = fetch, now: () => number = Date.now): ProjectTokenProvider {
  let cached: ProjectToken | null = null;
  let inflight: Promise<ProjectToken> | null = null;
  const fresh = (t: ProjectToken): boolean => {
    const exp = Date.parse(t.expiration);
    return Number.isFinite(exp) && now() < exp - REFRESH_BUFFER_MS;
  };
  const mint = async (): Promise<ProjectToken> => {
    const res = await fetchFn(boot.credentialsUrl, {
      method: "POST",
      headers: boot.credentialsToken ? { authorization: `Bearer ${boot.credentialsToken}` } : {},
      signal: AbortSignal.timeout(10 * 60 * 1000), // the FIRST mint creates the project — Google takes its minute
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* reported below */
    }
    if (!res.ok) throw new Error(typeof body.message === "string" ? body.message : `the host refused to mint a token (${res.status})`);
    if (body.cloud !== "gcp" || typeof body.accessToken !== "string" || typeof body.projectId !== "string") {
      throw new Error("expected a Google Cloud token — is MemoryPoppy connected to a Google Cloud project?");
    }
    return { accessToken: body.accessToken, projectId: body.projectId, serviceAccount: String(body.serviceAccount ?? ""), expiration: String(body.expiration ?? "") };
  };
  return () => {
    if (cached && fresh(cached)) return Promise.resolve(cached);
    if (!inflight) {
      inflight = mint()
        .then((t) => {
          cached = t;
          return t;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

// ---- The poppy's identity WITHOUT a host: inside its own project (DESIGN §18 G4 / memory-poppy §14 M6) ----

/** Where Google's metadata server answers, on a Cloud Run job or service. */
export const METADATA_URL = "http://metadata.google.internal/computeMetadata/v1";

/**
 * The same token, minted by Google's metadata server instead of the host: on Cloud Run the
 * process IS the poppy's service account, so there is nothing to vend — the host provisioned the
 * job to run as that account, with exactly its role. Cached and coalesced like the host's.
 */
export function createMetadataTokenProvider(fetchFn: FetchLike = fetch, now: () => number = Date.now, base = METADATA_URL): ProjectTokenProvider {
  let cached: ProjectToken | null = null;
  let inflight: Promise<ProjectToken> | null = null;
  const ask = async (path: string): Promise<string> => {
    let res: Response;
    try {
      res = await fetchFn(`${base}/${path}`, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error("Google's metadata server is not reachable — is this running on Cloud Run?");
    }
    if (!res.ok) throw new Error(`Google's metadata server answered ${res.status} for ${path} — is this running on Cloud Run?`);
    return res.text();
  };
  const mint = async (): Promise<ProjectToken> => {
    const [tokenText, projectId, serviceAccount] = await Promise.all([ask("instance/service-accounts/default/token"), ask("project/project-id"), ask("instance/service-accounts/default/email")]);
    const t = JSON.parse(tokenText) as { access_token?: string; expires_in?: number };
    if (typeof t.access_token !== "string") throw new Error("Google's metadata server gave no access token");
    return { accessToken: t.access_token, projectId: projectId.trim(), serviceAccount: serviceAccount.trim(), expiration: new Date(now() + (t.expires_in ?? 3600) * 1000).toISOString() };
  };
  return () => {
    if (cached && now() < Date.parse(cached.expiration) - REFRESH_BUFFER_MS) return Promise.resolve(cached);
    if (!inflight) {
      inflight = mint()
        .then((t) => {
          cached = t;
          return t;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

/** A Google ID token for one audience — how a poppy knocks on another poppy's door (M6). */
export type IdentityTokenProvider = (audience: string) => Promise<string>;

export function createIdentityTokenProvider(fetchFn: FetchLike = fetch, now: () => number = Date.now, base = METADATA_URL): IdentityTokenProvider {
  const cached = new Map<string, { token: string; expiresAt: number }>();
  return async (audience) => {
    const hit = cached.get(audience);
    if (hit && now() < hit.expiresAt - REFRESH_BUFFER_MS) return hit.token;
    const res = await fetchFn(`${base}/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Google's metadata server answered ${res.status} for an identity token — is this running on Cloud Run?`);
    const token = (await res.text()).trim();
    // The token's own exp claim, so the cache never hands out a stale one.
    let expiresAt = now() + 50 * 60 * 1000;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
      if (typeof payload.exp === "number") expiresAt = payload.exp * 1000;
    } catch {
      /* the default above */
    }
    cached.set(audience, { token, expiresAt });
    return token;
  };
}

/** Google refused, or failed: the HTTP status, Google's `status` word (NOT_FOUND, ALREADY_EXISTS…) and its message. */
export class GoogleError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface GoogleCallOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Tries in total (default 4: one plus three retries on 429/5xx). */
  tries?: number;
  timeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One call to a Google REST API with a bearer token. A 2xx returns the parsed body (`{}` for an
 * empty one); anything else throws a {@link GoogleError}. 429 and 5xx are retried with backoff.
 */
export async function googleJson<T = Record<string, unknown>>(
  url: string,
  init: { method?: string; body?: unknown } & { token: string },
  opts: GoogleCallOptions = {},
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const tries = opts.tries ?? 4;
  let last: GoogleError | null = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    const res = await doFetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${init.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    let parsed: unknown = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    if (res.ok) return parsed as T;
    const err = (parsed as { error?: { status?: string; message?: string } }).error;
    last = new GoogleError(res.status, err?.status ?? `HTTP_${res.status}`, err?.message ?? `Google returned ${res.status} for ${init.method ?? "GET"} ${url}`);
    if (!RETRY_STATUSES.has(res.status)) throw last;
  }
  throw last ?? new Error("unreachable");
}
