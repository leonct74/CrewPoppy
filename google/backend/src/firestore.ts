// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: PolyForm-Shield-1.0.0
//
// Copied from memory-poppy/backend/src — see google.ts for the rule.

/**
 * The wire to Firestore (DESIGN.md §4): the REST API at firestore.googleapis.com/v1, called with
 * the poppy's own project token, naming the poppy's own project, database `(default)`. No SDK —
 * the bundle stays one dependency-free file the host runs confined. The interface is small on
 * purpose, so the store's tests run against a fake of it and the store never learns the wire.
 */
import { type FetchLike, GoogleError, type ProjectTokenProvider, googleJson } from "./google";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface WireDoc<T = Json> {
  id: string;
  data: T;
}

export interface WireWrite {
  collection: string;
  id: string;
  data: object;
}

export interface IndexField {
  fieldPath: string;
  order: "ASCENDING" | "DESCENDING";
}

export interface FirestoreWire {
  /** The poppy's own project — from the token; the FIRST call creates the project (a minute). */
  projectId(): Promise<string>;
  /** `(default)` exists in this region when this returns; `created` says whether we made it now. */
  ensureDatabase(region: string): Promise<{ created: boolean; locationId: string }>;
  /** A composite index on the collection; already there is fine. */
  ensureIndex(collection: string, fields: IndexField[]): Promise<void>;
  get<T = Json>(collection: string, id: string): Promise<T | null>;
  set(collection: string, id: string, data: object): Promise<void>;
  /** Several documents in one atomic commit (chunked above Firestore's 500). */
  commit(writes: WireWrite[]): Promise<void>;
  /** Every document whose string `field` is greater than `after` (all of them when null), ascending. */
  listChanged<T = Json>(collection: string, field: string, after: string | null): Promise<WireDoc<T>[]>;
  /** Remove one document; a document that is not there is fine. */
  delete(collection: string, id: string): Promise<void>;
}

// ---- Firestore's typed values ⇄ plain JSON -------------------------------------------------

export type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { referenceValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export function encodeValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 2 ** 53 ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
  return { stringValue: String(v) };
}

/** `undefined` fields are left out, as JSON.stringify would. */
export function encodeFields(o: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = encodeValue(v);
  return out;
}

export function decodeValue(v: FsValue): Json {
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
}

export function decodeFields(fields: Record<string, FsValue>): { [k: string]: Json } {
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

// ---- The REST wire ---------------------------------------------------------------------------

const BASE = "https://firestore.googleapis.com/v1";
const DATABASE = "(default)";
const COMMIT_CHUNK = 400; // Firestore allows 500 writes per commit; leave room
const QUERY_PAGE = 500;

export interface RestFirestoreOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the database to come up (default 5 min). */
  createTimeoutMs?: number;
  log?: (line: string) => void;
}

interface FsDocument {
  name: string;
  fields?: Record<string, FsValue>;
  updateTime?: string;
}

interface Operation {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string; status?: string };
}

export class RestFirestore implements FirestoreWire {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(
    private readonly token: ProjectTokenProvider,
    private readonly opts: RestFirestoreOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
  }

  async projectId(): Promise<string> {
    return (await this.token()).projectId;
  }

  private async call<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}, timeoutMs?: number): Promise<T> {
    const t = await this.token();
    const url = path.startsWith("https://") ? path : `${BASE}/${path}`;
    return googleJson<T>(url, { ...init, token: t.accessToken }, { fetch: this.opts.fetch, sleep: this.sleep, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  private async db(): Promise<string> {
    return `projects/${await this.projectId()}/databases/${DATABASE}`;
  }

  private async docName(collection: string, id: string): Promise<string> {
    return `${await this.db()}/documents/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
  }

  /**
   * Does `(default)` exist? Asked by LISTING the project's databases: a GET by name answers 403
   * "The caller does not have permission" for a database that is not there, which says nothing.
   */
  private async findDatabase(): Promise<{ locationId?: string } | null> {
    const project = await this.projectId();
    const res = await this.call<{ databases?: Array<{ name?: string; locationId?: string }> }>(`projects/${project}/databases`);
    return (res.databases ?? []).find((d) => d.name?.endsWith(`/databases/${DATABASE}`)) ?? null;
  }

  async ensureDatabase(region: string): Promise<{ created: boolean; locationId: string }> {
    const existing = await this.findDatabase();
    if (existing) return { created: false, locationId: existing.locationId ?? region };
    this.log(`creating Firestore database ${DATABASE} in ${region}`);
    const project = await this.projectId();
    let op: Operation | null = null;
    try {
      op = await this.call<Operation>(`projects/${project}/databases?databaseId=${encodeURIComponent(DATABASE)}`, {
        method: "POST",
        body: { type: "FIRESTORE_NATIVE", locationId: region },
      });
    } catch (e) {
      // Two starts racing: the other one is creating it. Wait for it below.
      if (!(e instanceof GoogleError && e.status === 409)) throw e;
    }
    const deadline = Date.now() + (this.opts.createTimeoutMs ?? 5 * 60 * 1000);
    if (op && !op.done) {
      while (Date.now() < deadline) {
        await this.sleep(2000);
        op = await this.call<Operation>(op.name);
        if (op.done) break;
      }
      if (!op.done) throw new Error(`Firestore did not finish creating the database within the wait — try again in a minute`);
      if (op.error) throw new GoogleError(500, op.error.status ?? "OPERATION_FAILED", op.error.message ?? "Firestore could not create the database");
    }
    for (;;) {
      const made = await this.findDatabase();
      if (made) return { created: true, locationId: made.locationId ?? region };
      if (Date.now() >= deadline) throw new Error("Firestore reports the database created but does not list it yet — try again in a minute");
      await this.sleep(2000);
    }
  }

  async ensureIndex(collection: string, fields: IndexField[]): Promise<void> {
    const db = await this.db();
    try {
      await this.call(`${db}/collectionGroups/${encodeURIComponent(collection)}/indexes`, { method: "POST", body: { queryScope: "COLLECTION", fields } });
    } catch (e) {
      if (e instanceof GoogleError && e.status === 409) return; // already there
      throw e;
    }
  }

  async get<T = Json>(collection: string, id: string): Promise<T | null> {
    try {
      const doc = await this.call<FsDocument>(await this.docName(collection, id));
      return decodeFields(doc.fields ?? {}) as unknown as T;
    } catch (e) {
      if (e instanceof GoogleError && e.status === 404) return null;
      throw e;
    }
  }

  async set(collection: string, id: string, data: object): Promise<void> {
    await this.call(await this.docName(collection, id), { method: "PATCH", body: { fields: encodeFields(data as Record<string, unknown>) } });
  }

  async delete(collection: string, id: string): Promise<void> {
    try {
      await this.call(await this.docName(collection, id), { method: "DELETE" });
    } catch (e) {
      if (e instanceof GoogleError && e.status === 404) return;
      throw e;
    }
  }

  async commit(writes: WireWrite[]): Promise<void> {
    if (writes.length === 0) return;
    const db = await this.db();
    for (let i = 0; i < writes.length; i += COMMIT_CHUNK) {
      const chunk = writes.slice(i, i + COMMIT_CHUNK);
      await this.call(`${db}/documents:commit`, {
        method: "POST",
        body: {
          writes: chunk.map((w) => ({
            update: { name: `${db}/documents/${w.collection}/${w.id}`, fields: encodeFields(w.data as Record<string, unknown>) },
          })),
        },
      });
    }
  }

  async listChanged<T = Json>(collection: string, field: string, after: string | null): Promise<WireDoc<T>[]> {
    const db = await this.db();
    const out: WireDoc<T>[] = [];
    let cursor: { value: string; name: string } | null = null;
    for (;;) {
      const structuredQuery: Record<string, unknown> = {
        from: [{ collectionId: collection }],
        orderBy: [
          { field: { fieldPath: field }, direction: "ASCENDING" },
          { field: { fieldPath: "__name__" }, direction: "ASCENDING" },
        ],
        limit: QUERY_PAGE,
      };
      if (after !== null) structuredQuery.where = { fieldFilter: { field: { fieldPath: field }, op: "GREATER_THAN", value: { stringValue: after } } };
      if (cursor) structuredQuery.startAt = { values: [{ stringValue: cursor.value }, { referenceValue: cursor.name }], before: false };
      const rows = await this.call<Array<{ document?: FsDocument }>>(`${db}/documents:runQuery`, { method: "POST", body: { structuredQuery } }, 60_000);
      const docs = (Array.isArray(rows) ? rows : []).map((r) => r.document).filter((d): d is FsDocument => !!d);
      for (const d of docs) {
        const data = decodeFields(d.fields ?? {});
        out.push({ id: d.name.slice(d.name.lastIndexOf("/") + 1), data: data as unknown as T });
      }
      if (docs.length < QUERY_PAGE) return out;
      const lastDoc = docs[docs.length - 1]!;
      const lastValue = decodeFields(lastDoc.fields ?? {})[field];
      cursor = { value: typeof lastValue === "string" ? lastValue : "", name: lastDoc.name };
    }
  }
}
