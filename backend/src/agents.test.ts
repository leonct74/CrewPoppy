import { describe, expect, it, vi } from "vitest";
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import {
  clearHistory, deleteAgent, fileLink, listFiles, putOwnerFile, readFileContent, saveAgent,
  withStaleness, deleteFile } from "./agents";
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

// The open-inbox flag (DESIGN §15g) is a stored GRANT, so what survives the save
// matters more than what the form sent.
describe("who may email an agent", () => {
  const NOW = "2026-07-26T12:00:00.000Z";
  const input = {
    name: "Emma", role: "Support", instructions: "…", modelId: "m",
    emailFrom: "support@ollydigital.com",
  };

  it("opens only on the literal true", async () => {
    const { client } = fakeDdb([]);
    expect((await saveAgent(client, "t", "a1", { ...input, openInbox: true }, NOW)).openInbox).toBe(true);
    for (const v of [false, "true", 1, null, undefined]) {
      const d = await saveAgent(client, "t", "a1", { ...input, openInbox: v }, NOW);
      expect(d.openInbox).toBeUndefined();
    }
  });

  it("stays open across an edit that doesn't mention it, and closes on false", async () => {
    const open = { pk: AGENTS_PK, sk: agentSk("a1"), ...AGENT, emailFrom: "support@ollydigital.com", openInbox: true };
    const kept = await saveAgent(fakeDdb([open]).client, "t", "a1", input, NOW);
    expect(kept.openInbox).toBe(true);
    const closed = await saveAgent(fakeDdb([open]).client, "t", "a1", { ...input, openInbox: false }, NOW);
    expect(closed.openInbox).toBeUndefined();
  });

  it("stores a face only when it's a catalogue id, and '' takes it away", async () => {
    const { client } = fakeDdb([]);
    expect((await saveAgent(client, "t", "a1", { ...input, avatar: "av-17" }, NOW)).avatar).toBe("av-17");
    for (const v of ["av-999", "portrait.png", 17, { id: "av-17" }]) {
      expect((await saveAgent(client, "t", "a1", { ...input, avatar: v }, NOW)).avatar).toBeUndefined();
    }
    const withFace = { pk: AGENTS_PK, sk: agentSk("a1"), ...AGENT, avatar: "av-03" };
    expect((await saveAgent(fakeDdb([withFace]).client, "t", "a1", input, NOW)).avatar).toBe("av-03");
    expect((await saveAgent(fakeDdb([withFace]).client, "t", "a1", { ...input, avatar: "" }, NOW)).avatar)
      .toBeUndefined();
  });

  it("never survives without an address — a door flag with no door", async () => {
    const d = await saveAgent(
      fakeDdb([]).client, "t", "a1", { ...input, emailFrom: "", openInbox: true }, NOW,
    );
    expect(d.emailFrom).toBeUndefined();
    expect(d.openInbox).toBeUndefined();
  });

  // §15i: the approval channel is stored ONLY as the literal "phone" — email is
  // absence, so every agent saved before the field existed already means email.
  it("moves approvals to the phone only on the literal 'phone'", async () => {
    const { client } = fakeDdb([]);
    expect(
      (await saveAgent(client, "t", "a1", { ...input, approvalChannel: "phone" }, NOW)).approvalChannel,
    ).toBe("phone");
    for (const v of ["email", "both", true, 1, null, undefined, "PHONE"]) {
      const d = await saveAgent(client, "t", "a1", { ...input, approvalChannel: v }, NOW);
      expect(d.approvalChannel).toBeUndefined();
    }
  });

  it("keeps the phone channel across an edit that doesn't mention it, and 'email' clears it", async () => {
    const phone = { pk: AGENTS_PK, sk: agentSk("a1"), ...AGENT, approvalChannel: "phone" };
    const kept = await saveAgent(fakeDdb([phone]).client, "t", "a1", input, NOW);
    expect(kept.approvalChannel).toBe("phone");
    const back = await saveAgent(fakeDdb([phone]).client, "t", "a1", { ...input, approvalChannel: "email" }, NOW);
    expect(back.approvalChannel).toBeUndefined();
  });
});

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

// The owner's window into the workspace. Same prefix rule as the dispatcher, same
// traversal predicate — one rule, both sides.
describe("reading an agent's files", () => {
  it("lists only this agent's files, with the prefix stripped", async () => {
    const s3 = {
      send: vi.fn(async () => ({
        Contents: [
          { Key: "agents/a1/report.md", Size: 1200, LastModified: new Date("2026-07-28T08:00:00Z") },
          { Key: "agents/a1/drafts/post.md", Size: 300 },
          { Key: "agents/a1/", Size: 0 }, // a folder marker is not a file
        ],
        IsTruncated: false,
      })),
    } as unknown as S3Client;
    const files = await listFiles(s3, "bucket", "a1");
    expect(files.map((f) => f.path)).toEqual(["report.md", "drafts/post.md"]);
    expect((s3.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].input.Prefix).toBe("agents/a1/");
  });

  it("treats a bucket that doesn't exist yet as an empty folder", async () => {
    const s3 = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("gone"), { name: "NoSuchBucket" });
      }),
    } as unknown as S3Client;
    expect(await listFiles(s3, "bucket", "a1")).toEqual([]);
  });

  it("refuses a traversal path without ever calling S3", async () => {
    const s3 = { send: vi.fn() } as unknown as S3Client;
    for (const path of ["../a2/secret.txt", "/etc/passwd", "a/../../b", ""]) {
      expect(await readFileContent(s3, "bucket", "a1", path)).toBeNull();
    }
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("reads a legitimate file from this agent's own prefix", async () => {
    const s3 = {
      send: vi.fn(async (c: { input: { Key: string } }) => ({
        Body: { transformToString: async () => `contents of ${c.input.Key}` },
      })),
    } as unknown as S3Client;
    const content = await readFileContent(s3, "bucket", "a1", "drafts/post.md");
    expect(content).toBe("contents of agents/a1/drafts/post.md");
  });

  it("answers null, not an error, for a file that's gone", async () => {
    const s3 = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("no key"), { name: "NoSuchKey" });
      }),
    } as unknown as S3Client;
    expect(await readFileContent(s3, "bucket", "a1", "gone.md")).toBeNull();
  });
});

// The template story (founder, 2026-07-28): the owner puts invoice-template.md in the
// agent's folder; the agent reads and follows it. Same rules as every other write.
describe("the owner saving a file into the workspace", () => {
  const fakePut = () => {
    const sent: unknown[] = [];
    const client = { send: vi.fn(async (c: unknown) => { sent.push(c); return {}; }) } as unknown as S3Client;
    return { client, sent };
  };

  it("lands under the agent's own prefix, as text", async () => {
    const { client, sent } = fakePut();
    const out = await putOwnerFile(client, "bucket", "a1", "invoice-template.md", "## Invoice {n}");
    expect(out.ok).toBe(true);
    const put = sent[0] as { input: { Key: string; ContentType: string } };
    expect(put.input.Key).toBe("agents/a1/invoice-template.md");
    expect(put.input.ContentType).toMatch(/text\/plain/);
  });

  it("refuses traversal and emptiness without touching S3", async () => {
    const { client, sent } = fakePut();
    expect((await putOwnerFile(client, "b", "a1", "../a2/x.md", "hi")).ok).toBe(false);
    expect((await putOwnerFile(client, "b", "a1", "x.md", "   ")).ok).toBe(false);
    expect((await putOwnerFile(client, "b", "a1", "x.md", 42)).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("the owner deleting one of an agent's files (founder, 2026-07-31)", () => {
  const fake = () => {
    const sent: any[] = [];
    const client = { send: vi.fn(async (c: unknown) => { sent.push(c); return {}; }) } as unknown as S3Client;
    return { client, sent };
  };

  it("deletes exactly that file, under the agent's own prefix", async () => {
    const { client, sent } = fake();
    expect((await deleteFile(client, "bucket", "a1", "draft.md")).ok).toBe(true);
    expect(sent[0].input).toEqual({ Bucket: "bucket", Key: "agents/a1/draft.md" });
  });

  it("refuses a traversal path WITHOUT touching S3 — one agent can't delete another's", async () => {
    const { client, sent } = fake();
    for (const bad of ["../a2/secret.md", "/etc/passwd", "https://x/y", ""]) {
      expect((await deleteFile(client, "b", "a1", bad)).ok).toBe(false);
    }
    expect(sent).toHaveLength(0);
  });

  it("is idempotent — a file already gone is a success, so a double-click is harmless", async () => {
    const client = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
      }),
    } as unknown as S3Client;
    expect((await deleteFile(client, "b", "a1", "x.md")).ok).toBe(true);
  });

  it("does NOT swallow a real failure — a denied delete must be visible", async () => {
    const client = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      }),
    } as unknown as S3Client;
    await expect(deleteFile(client, "b", "a1", "x.md")).rejects.toThrow(/denied/);
  });
});

describe("signed file links", () => {
  it("refuses a traversal path before any signing happens", async () => {
    const s3 = { send: vi.fn() } as unknown as S3Client;
    expect(await fileLink(s3, "bucket", "a1", "../a2/offer.pdf")).toBeNull();
    expect(await fileLink(s3, "bucket", "a1", "/etc/x")).toBeNull();
  });
});

// "Clean the chat history" (founder, 2026-07-28). The point that must hold: clearing a
// conversation removes the RECORD, never the agent's accumulated value or its cost cap.
describe("clearing an agent's history", () => {
  const now = at("2026-07-26T12:00:00.000Z");

  it("removes runs, transcripts and checkpoints — and NOTHING else", async () => {
    const { client: ddb, rows } = fakeDdb(world("succeeded"));
    const out = await clearHistory(ddb, "T", "a1", now);
    expect(out.ok).toBe(true);
    expect(out.removed?.runs).toBe(1);
    // The record is gone…
    expect(rows.find((r) => r.pk === agentPk("a1") && String(r.sk).startsWith("run#"))).toBeFalsy();
    expect(rows.find((r) => r.pk === transcriptPk("r1"))).toBeFalsy();
    expect(rows.find((r) => r.pk === checkpointPk("r1"))).toBeFalsy();
    // …and everything of lasting value stays: definition, memory, and the SPEND COUNTER,
    // because tidying a chat must never reset a cost cap.
    expect(rows.find((r) => r.sk === agentSk("a1"))).toBeTruthy();
    expect(rows.filter((r) => r.pk === memoryPk("a1"))).toHaveLength(2);
    expect(rows.find((r) => r.pk === spendPk("a1"))).toBeTruthy();
  });

  it("refuses while a run is live, same as delete", async () => {
    const { client: ddb, rows } = fakeDdb(world("running", "2026-07-26T11:59:30.000Z"));
    const out = await clearHistory(ddb, "T", "a1", now);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/working right now/i);
    expect(rows.find((r) => r.pk === agentPk("a1") && String(r.sk).startsWith("run#"))).toBeTruthy();
  });

  it("an agent with no history clears to a clean no-op", async () => {
    const { client: ddb } = fakeDdb(world());
    expect((await clearHistory(ddb, "T", "a1", now)).ok).toBe(true);
  });
});
