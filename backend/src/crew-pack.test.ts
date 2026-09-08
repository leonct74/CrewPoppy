// The Crew Pack, this edition's edge: what the export writes is the shared format; what comes
// back — from here or from the Google edition — goes through the editor's own sanitisers.
import { describe, expect, it, vi } from "vitest";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AGENTS_PK, agentSk, type AgentDef, memoryPk, memorySk } from "@crewpoppy/shared";
import { PACK_FORMAT, type CrewPack } from "../../shared/src/pack";
import { BRIEF_TASK, applyCrewPack, buildCrewPack, modelClassOf, modelIdFor, planCrewPack } from "./crew-pack";

const NOW = "2026-09-08T10:00:00.000Z";

function fakeDdb(items: Record<string, unknown>[] = []) {
  const rows = [...items] as { pk: string; sk: string }[];
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      if (cmd instanceof QueryCommand) {
        const pk = (cmd.input.ExpressionAttributeValues as Record<string, string>)[":pk"];
        return { Items: rows.filter((r) => r.pk === pk) };
      }
      if (cmd instanceof GetCommand) {
        const { pk, sk } = cmd.input.Key as { pk: string; sk: string };
        return { Item: rows.find((r) => r.pk === pk && r.sk === sk) };
      }
      if (cmd instanceof PutCommand) {
        const item = cmd.input.Item as { pk: string; sk: string };
        const i = rows.findIndex((r) => r.pk === item.pk && r.sk === item.sk);
        if (i >= 0) rows[i] = item;
        else rows.push(item);
        return {};
      }
      return {};
    }),
  } as unknown as DynamoDBDocumentClient;
  return { client, rows };
}

type Obj = { bytes: Buffer; contentType?: string };
function fakeS3(objects: Record<string, Obj>) {
  const store = new Map(Object.entries(objects));
  const client = {
    send: vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        const prefix = cmd.input.Prefix ?? "";
        return { Contents: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([Key, o]) => ({ Key, Size: o.bytes.length, LastModified: new Date(NOW) })) };
      }
      if (cmd instanceof GetObjectCommand) {
        const o = store.get(cmd.input.Key ?? "");
        if (!o) throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
        return { Body: { transformToString: async () => o.bytes.toString("utf8"), transformToByteArray: async () => new Uint8Array(o.bytes) } };
      }
      if (cmd instanceof PutObjectCommand) {
        const body = cmd.input.Body;
        store.set(cmd.input.Key ?? "", { bytes: Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8"), contentType: cmd.input.ContentType });
        return {};
      }
      return {};
    }),
  } as unknown as S3Client;
  return { client, store };
}

const emma: AgentDef = {
  id: "id-emma",
  name: "Emma",
  role: "Research Assistant",
  instructions: "Be concise.",
  avatar: "av-03",
  modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
  tools: ["memory_read", "memory_write", "workspace_write"],
  schedule: { kind: "daily", hour: 9, minute: 0, weekday: 1, timezone: "Europe/Rome", task: "Write the morning note.", enabled: true },
  caps: { maxIterations: 8, maxTokensPerRun: 20_000, maxWallClockMs: 120_000, monthlySpendCapUsd: 7 },
  createdAt: NOW,
  updatedAt: NOW,
};
const row = (a: AgentDef) => ({ pk: AGENTS_PK, sk: agentSk(a.id), ...a });

describe("the Crew Pack — this edition's edge", () => {
  it("knows a model's class and the catalogue's pick for a class", () => {
    expect(modelClassOf("anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("light");
    expect(modelClassOf("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("standard");
    expect(modelClassOf("anthropic.claude-opus-4-1-20250805-v1:0")).toBe("deep");
    expect(modelIdFor("light")).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(modelIdFor("auto")).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(modelIdFor("standard")).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(modelIdFor("deep")).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
  });

  it("writes the shared format: agents in the live app's terms with the model as a class, what each remembered, text files as text and a PDF as base64 — and says what stayed behind", async () => {
    const ddb = fakeDdb([row(emma), { pk: memoryPk("id-emma"), sk: memorySk("tone"), key: "tone", value: "warm" }, { pk: memoryPk("id-emma"), sk: memorySk("broken"), key: "broken" }]);
    const s3 = fakeS3({
      "agents/id-emma/drafts/a.txt": { bytes: Buffer.from("Dear all", "utf8") },
      "agents/id-emma/report.pdf": { bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
      "agents/id-emma/huge.bin": { bytes: Buffer.alloc(5 * 1024 * 1024 + 1) },
      "agents/someone-else/secret.txt": { bytes: Buffer.from("not yours", "utf8") },
    });
    const pack = await buildCrewPack(ddb.client, "t", s3.client, "b", NOW);
    expect(pack).toEqual({
      format: PACK_FORMAT,
      version: 2,
      exportedAt: NOW,
      edition: "aws",
      poppy: "com.crewpoppy.desktop",
      agents: [{ id: "id-emma", name: "Emma", role: "Research Assistant", instructions: "Be concise.", tools: ["memory_read", "memory_write", "workspace_write"], capUsd: 7, model: "light", avatar: "av-03", schedule: { kind: "daily", hour: 9, minute: 0, weekday: 1, timezone: "Europe/Rome", task: "Write the morning note.", enabled: true }, createdAt: NOW, updatedAt: NOW }],
      notes: [{ agent: "id-emma", key: "tone", value: "warm" }],
      files: [
        { agent: "id-emma", path: "drafts/a.txt", content: "Dear all", updatedAt: NOW },
        { agent: "id-emma", path: "report.pdf", content: "JVBERg==", encoding: "base64", updatedAt: NOW },
      ],
      omitted: ["Emma's huge.bin — over 5 MB"],
    });
    expect(JSON.stringify(pack)).not.toMatch(/token|receipt|secret|arn:/i);
  });

  it("brings a Google-made pack in through the editor's own door: the class picks a model, unknown tools are left off and said, a task-less schedule is given words, memories and files land only for kept agents", async () => {
    const ddb = fakeDdb();
    const s3 = fakeS3({});
    const pack: CrewPack = {
      format: PACK_FORMAT,
      version: 2,
      exportedAt: NOW,
      edition: "google",
      poppy: "com.crewpoppy.cloud.google",
      agents: [
        { id: "bo", name: "Bo", role: "Poet", instructions: "Write a haiku.", tools: ["workspace_append", "memory_write", "teleport"], capUsd: 3, model: "deep", memory: false, schedule: { kind: "daily", hour: 9, minute: 0, weekday: 1, timezone: "", task: "", enabled: true } },
        { id: "no-role", name: "Ann", role: "", instructions: "x", tools: [], capUsd: 1 },
        { id: "x", name: "", role: "r", instructions: "i", tools: [], capUsd: 1 },
      ],
      notes: [
        { agent: "bo", key: "style", value: "short" },
        { agent: "bo", key: "", value: "x" },
        { agent: "ghost", key: "k", value: "v" },
      ],
      files: [
        { agent: "bo", path: "haiku/first.txt", content: "old pond" },
        { agent: "bo", path: "report.pdf", content: "JVBERg==", encoding: "base64" },
        { agent: "bo", path: "../ann/notes.txt", content: "steal" },
      ],
    };
    const plan = await planCrewPack(ddb.client, "t", pack, NOW, "Europe/Rome");
    expect(plan).toEqual({
      applied: false,
      create: ["Bo"],
      update: [],
      notes: 1,
      files: 2,
      skipped: ['Bo: no tool is called "teleport" here — left off', `Bo's schedule had no task — set to "${BRIEF_TASK}"`, "Ann: a role and instructions are needed", "(unnamed): a name is needed", 'a memory of bo ("") — not one memory_write would keep', 'a file of bo ("../ann/notes.txt") — not a file the workspace would keep'],
      totalMonthlyCapUsd: 3,
    });
    expect(ddb.rows).toEqual([]); // a plan writes nothing
    const done = await applyCrewPack(ddb.client, "t", s3.client, "b", pack, NOW, "Europe/Rome");
    expect(done).toMatchObject({ applied: true, create: ["Bo"], notes: 1, files: 2 });
    const bo = ddb.rows.find((r) => r.sk === agentSk("bo")) as unknown as AgentDef;
    expect(bo).toMatchObject({ id: "bo", name: "Bo", modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0", tools: ["workspace_append", "memory_write"], schedule: { kind: "daily", hour: 9, minute: 0, timezone: "Europe/Rome", task: BRIEF_TASK, enabled: true } });
    expect(bo.caps.monthlySpendCapUsd).toBe(3);
    expect(ddb.rows.find((r) => r.pk === memoryPk("bo") && r.sk === memorySk("style"))).toMatchObject({ key: "style", value: "short" });
    expect(s3.store.get("agents/bo/haiku/first.txt")?.bytes.toString("utf8")).toBe("old pond");
    expect(s3.store.get("agents/bo/report.pdf")).toEqual({ bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf" });
    expect(s3.store.has("agents/ann/notes.txt")).toBe(false);
  });

  it("round-trips its own export: an agent with the same id is updated and keeps its model when the class still fits", async () => {
    const ddb = fakeDdb([row(emma), { pk: memoryPk("id-emma"), sk: memorySk("tone"), key: "tone", value: "warm" }]);
    const s3 = fakeS3({ "agents/id-emma/drafts/a.txt": { bytes: Buffer.from("Dear all", "utf8") } });
    const pack = await buildCrewPack(ddb.client, "t", s3.client, "b", NOW);
    const fresh = fakeDdb([row({ ...emma, modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", role: "Old role" })]);
    const target = fakeS3({});
    const done = await applyCrewPack(fresh.client, "t", target.client, "b", pack, "2026-09-09T00:00:00.000Z", "UTC");
    expect(done).toEqual({ applied: true, create: [], update: ["Emma"], notes: 1, files: 1, skipped: [], totalMonthlyCapUsd: 7 });
    const back = fresh.rows.find((r) => r.sk === agentSk("id-emma")) as unknown as AgentDef;
    expect(back).toMatchObject({ role: "Research Assistant", modelId: emma.modelId, avatar: "av-03", tools: emma.tools, schedule: emma.schedule, createdAt: NOW, updatedAt: "2026-09-09T00:00:00.000Z" });
    expect(back.caps.monthlySpendCapUsd).toBe(7);
    expect(target.store.get("agents/id-emma/drafts/a.txt")?.bytes.toString("utf8")).toBe("Dear all");
  });
});
