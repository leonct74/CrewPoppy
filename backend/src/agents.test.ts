import { describe, expect, it, vi } from "vitest";
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { deleteAgent, withStaleness } from "./agents";
import {
  AGENTS_PK,
  CHECKPOINT_SK,
  DEFAULT_CAPS,
  agentPk,
  agentSk,
  checkpointPk,
  memoryPk,
  runSk,
  spendPk,
  spendSk,
  transcriptPk,
  type RunRecord,
} from "@crewpoppy/shared";

const base: RunRecord = {
  runId: "r1",
  agentId: "a1",
  status: "running",
  input: "Do the thing",
  cost: { usage: { inputTokens: 0, outputTokens: 0 } },
  iterations: 0,
  startedAt: "2026-07-26T10:00:00.000Z",
  modelId: "qwen.qwen3-32b-v1:0",
};
const at = (iso: string) => Date.parse(iso);

// Regression: two real runs sat at "running" forever because the deployed Lambda was
// the empty P0 stub and never reported back. A run must never spin indefinitely.
describe("a run that never reports back is not 'still running'", () => {
  it("leaves a genuinely fresh run alone", () => {
    const r = withStaleness(base, DEFAULT_CAPS, at("2026-07-26T10:00:30.000Z"));
    expect(r.status).toBe("running");
  });

  it("still allows for a slow run inside its own wall-clock cap", () => {
    // 100s in, against a 120s cap — slow, but legitimately working.
    const r = withStaleness(base, DEFAULT_CAPS, at("2026-07-26T10:01:40.000Z"));
    expect(r.status).toBe("running");
  });

  it("marks a run failed once it is past its cap plus a generous margin", () => {
    const r = withStaleness(base, DEFAULT_CAPS, at("2026-07-26T10:10:00.000Z"));
    expect(r.status).toBe("failed");
    // …and points at the actual cause rather than blaming the model.
    expect(r.message).toMatch(/never reported back/i);
    expect(r.message).toMatch(/out of date/i);
  });

  it("respects a longer wall-clock cap before declaring anything wrong", () => {
    const caps = { ...DEFAULT_CAPS, maxWallClockMs: 600_000 };
    const r = withStaleness(base, caps, at("2026-07-26T10:05:00.000Z"));
    expect(r.status).toBe("running");
  });

  it("never rewrites a run that already finished", () => {
    for (const status of ["succeeded", "failed", "stopped"] as const) {
      const done = { ...base, status, finishedAt: "2026-07-26T10:00:10.000Z" };
      expect(withStaleness(done, DEFAULT_CAPS, at("2026-08-01T00:00:00.000Z"))).toEqual(done);
    }
  });

  it("does not choke on an unparseable start time", () => {
    const bad = { ...base, startedAt: "not-a-date" };
    expect(withStaleness(bad, DEFAULT_CAPS, Date.now()).status).toBe("running");
  });
});

// ---------------------------------------------------------------------------

/** A DynamoDB standing in for the real one: an in-memory single table. */
function fakeDdb(items: Record<string, unknown>[]) {
  const rows = [...items] as { pk: string; sk: string }[];
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        const { pk, sk } = cmd.input.Key as { pk: string; sk: string };
        return { Item: rows.find((r) => r.pk === pk && r.sk === sk) };
      }
      if (cmd instanceof QueryCommand) {
        const pk = (cmd.input.ExpressionAttributeValues as Record<string, string>)[":pk"];
        const prefix = (cmd.input.ExpressionAttributeValues as Record<string, string>)[":sk"];
        return {
          Items: rows.filter((r) => r.pk === pk && (!prefix || r.sk.startsWith(prefix))),
        };
      }
      if (cmd instanceof DeleteCommand) {
        const { pk, sk } = cmd.input.Key as { pk: string; sk: string };
        const i = rows.findIndex((r) => r.pk === pk && r.sk === sk);
        if (i >= 0) rows.splice(i, 1);
        return {};
      }
      return {};
    }),
  } as unknown as DynamoDBDocumentClient;
  return { client, rows };
}

/** An S3 standing in for the workspace bucket. */
function fakeS3(keys: string[]) {
  const left = [...keys];
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        const prefix = cmd.input.Prefix ?? "";
        return { Contents: left.filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })) };
      }
      if (cmd instanceof DeleteObjectsCommand) {
        for (const o of cmd.input.Delete?.Objects ?? []) {
          const i = left.indexOf(o.Key!);
          if (i >= 0) left.splice(i, 1);
        }
        return {};
      }
      return {};
    }),
  } as unknown as S3Client;
  return { client, left };
}

const AGENT = {
  id: "a1",
  name: "Emma",
  role: "Research Assistant",
  instructions: "…",
  modelId: "qwen.qwen3-32b-v1:0",
  tools: [],
  caps: DEFAULT_CAPS,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function world(runStatus?: RunRecord["status"], startedAt = "2026-07-26T10:00:00.000Z") {
  const rows: Record<string, unknown>[] = [
    { pk: AGENTS_PK, sk: agentSk("a1"), ...AGENT },
    { pk: AGENTS_PK, sk: agentSk("a2"), ...AGENT, id: "a2", name: "Sam" },
    // The other agent's data — the thing a delete must never touch.
    { pk: agentPk("a2"), sk: runSk("r9"), ...base, agentId: "a2", runId: "r9", status: "succeeded" },
    { pk: memoryPk("a2"), sk: "k#tone", value: "friendly" },
    { pk: memoryPk("a1"), sk: "k#tone", value: "brisk" },
    { pk: memoryPk("a1"), sk: "k#customer", value: "Jane, 07700 900123" },
    { pk: spendPk("a1"), sk: spendSk("2026-07"), usd: 1.23 },
  ];
  if (runStatus) {
    rows.push({ pk: agentPk("a1"), sk: runSk("r1"), ...base, status: runStatus, startedAt });
    rows.push({ pk: transcriptPk("r1"), sk: "msg#000001", role: "user", text: "hello" });
    rows.push({ pk: checkpointPk("r1"), sk: CHECKPOINT_SK, messages: [] });
  }
  return rows;
}

describe("deleting an agent", () => {
  const now = at("2026-07-26T12:00:00.000Z");

  it("removes its memory, files, runs, transcript and checkpoint — not just the row", async () => {
    const { client: ddb, rows } = fakeDdb(world("succeeded"));
    const { client: s3, left } = fakeS3(["agents/a1/report.md", "agents/a1/notes.txt", "agents/a2/keep.md"]);

    const out = await deleteAgent(ddb, s3, "T", "bucket", "a1", now);

    expect(out.ok).toBe(true);
    expect(out.removed).toEqual({ runs: 1, memories: 2, files: 2 });
    // Nothing of a1 is left anywhere.
    expect(rows.filter((r) => JSON.stringify(r).includes("a1"))).toEqual([]);
    expect(left).toEqual(["agents/a2/keep.md"]);
  });

  it("leaves every other agent completely alone", async () => {
    const { client: ddb, rows } = fakeDdb(world("succeeded"));
    const { client: s3 } = fakeS3([]);
    await deleteAgent(ddb, s3, "T", "bucket", "a1", now);
    expect(rows.filter((r) => r.pk === agentPk("a2") || r.pk === memoryPk("a2"))).toHaveLength(2);
    expect(rows.find((r) => r.sk === agentSk("a2"))).toBeTruthy();
  });

  // Deleting the definition under a live Lambda would leave a run that can neither
  // finish nor be found. Refuse, and say what to do instead.
  it("refuses while a run is actually working, and keeps everything", async () => {
    const { client: ddb, rows } = fakeDdb(world("running", "2026-07-26T11:59:30.000Z"));
    const { client: s3 } = fakeS3(["agents/a1/report.md"]);
    const out = await deleteAgent(ddb, s3, "T", "bucket", "a1", now);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/working right now/i);
    expect(out.reason).toMatch(/stop the run/i);
    expect(rows.find((r) => r.sk === agentSk("a1"))).toBeTruthy();
  });

  it("refuses while a run is waiting on the owner, and says which it is", async () => {
    const { client: ddb } = fakeDdb(world("waiting"));
    const { client: s3 } = fakeS3([]);
    const out = await deleteAgent(ddb, s3, "T", "bucket", "a1", now);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/waiting for your answer/i);
  });

  // A run stuck at "running" because its Lambda never reported back must not make an
  // agent undeletable forever — the same staleness rule the UI already applies.
  it("is not blocked by a run that never reported back", async () => {
    const { client: ddb, rows } = fakeDdb(world("running", "2026-07-26T09:00:00.000Z"));
    const { client: s3 } = fakeS3([]);
    const out = await deleteAgent(ddb, s3, "T", "bucket", "a1", now);
    expect(out.ok).toBe(true);
    expect(rows.find((r) => r.sk === agentSk("a1"))).toBeFalsy();
  });

  it("treats an agent that is already gone as done, so a retry is safe", async () => {
    const { client: ddb } = fakeDdb([]);
    const { client: s3 } = fakeS3([]);
    const out = await deleteAgent(ddb, s3, "T", "bucket", "a1", now);
    expect(out.ok).toBe(true);
  });

  it("survives a workspace bucket that doesn't exist yet", async () => {
    const { client: ddb, rows } = fakeDdb(world());
    const s3 = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("no bucket"), { name: "NoSuchBucket" });
      }),
    } as unknown as S3Client;
    const out = await deleteAgent(ddb, s3, "T", "bucket", "a1", now);
    expect(out.ok).toBe(true);
    expect(rows.find((r) => r.sk === agentSk("a1"))).toBeFalsy();
  });
});
