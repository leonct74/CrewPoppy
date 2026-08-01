// The crew-as-a-spreadsheet contract (founder, 2026-08-01): what the export writes the
// import accepts back UNCHANGED; rows match agents by name; a file with any broken row
// changes nothing at all. And the one localisation trap that WILL happen to this
// founder: Excel-Europe saves "CSV" with semicolons and writes 2,50 for 2.50.
import { describe, expect, it, vi } from "vitest";
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AGENTS_PK, agentSk, type AgentDef } from "@crewpoppy/shared";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyImport, crewToCsv, parseCsv, planImport, saveCsvToDownloads, MAX_IMPORT_ROWS } from "./crew-csv";

const NOW = "2026-08-01T12:00:00.000Z";

/** In-memory table: enough of DynamoDB for listAgents + saveAgent. */
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

const emma: AgentDef = {
  id: "id-emma",
  name: "Emma",
  role: "Research Assistant",
  instructions: 'Be concise.\nQuote "sources", always.', // newline + quotes + comma: the CSV torture row
  modelId: "qwen.qwen3-32b-v1:0",
  tools: ["memory_read", "memory_write"],
  emailFrom: "emma@ollydigital.com",
  openInbox: true,
  approvalChannel: "phone",
  caps: { maxIterations: 8, maxTokensPerRun: 20_000, maxWallClockMs: 120_000, monthlySpendCapUsd: 7 },
  createdAt: NOW,
  updatedAt: NOW,
};
const row = (a: AgentDef) => ({ pk: AGENTS_PK, sk: agentSk(a.id), ...a });

describe("export ↔ import round-trip", () => {
  it("what the export writes, the import reads back as zero changes of substance", async () => {
    const { client } = fakeDdb([row(emma)]);
    const csv = crewToCsv([emma]);
    const plan = await planImport(client, "t", csv, NOW);
    expect(plan.errors).toEqual([]);
    expect(plan.created).toBe(0);
    expect(plan.updated).toBe(1);
    expect(plan.saves[0]!.id).toBe("id-emma"); // matched by name → same identity
    expect(plan.saves[0]!.input).toMatchObject({
      name: "Emma",
      instructions: emma.instructions, // newline and quotes survived the trip
      tools: ["memory_read", "memory_write"],
      openInbox: true,
      approvalChannel: "phone",
      caps: { monthlySpendCapUsd: 7 },
    });
  });

  it("with no crew, the export is the template — header plus one example row", () => {
    const rows = parseCsv(crewToCsv([]));
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe("Name");
    expect(rows[1]![0]).toMatch(/replace this row/i);
  });
});

describe("what Excel actually saves", () => {
  it("semicolon-delimited CSV (Excel in the founder's locale) parses identically", () => {
    const rows = parseCsv('Name;Role;Monthly cap USD\r\n"Rossi; Emma";Support;2,50\r\n');
    expect(rows).toEqual([
      ["Name", "Role", "Monthly cap USD"],
      ["Rossi; Emma", "Support", "2,50"],
    ]);
  });

  it("a comma-decimal cap (2,50) is money, not an error", async () => {
    const { client } = fakeDdb();
    const csv = "Name;Role;Instructions;Model;Monthly cap USD\nEmma;Support;Help.;m1;2,50\n";
    const plan = await planImport(client, "t", csv, NOW);
    expect(plan.errors).toEqual([]);
    expect(plan.totalMonthlyCapUsd).toBe(2.5);
  });

  it("a BOM and trailing blank lines are invisible, not agents", () => {
    const rows = parseCsv("﻿Name,Role\nEmma,Support\n\n\n");
    expect(rows).toEqual([["Name", "Role"], ["Emma", "Support"]]);
  });

  it("TAB-separated text — what the clipboard holds after copying cells — parses too", () => {
    const rows = parseCsv("Name\tRole\tMonthly cap USD\nEmma\tSupport\t10\n");
    expect(rows).toEqual([
      ["Name", "Role", "Monthly cap USD"],
      ["Emma", "Support", "10"],
    ]);
  });
});

// 🪤 The regression that made the first version of this feature a dead button: the
// frontend cannot save a file at all (sandboxed frame — `<a download>` does nothing),
// so the SIDECAR writes it. These pin the behaviour that has to hold on disk.
describe("saving the file the owner asked for", () => {
  it("writes into the given folder and reports the name to look for", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crewpoppy-dl-"));
    const out = await saveCsvToDownloads("Name,Role\r\nEmma,Support\r\n", "crewpoppy-agents.csv", dir);
    expect(out.savedAs).toBe("crewpoppy-agents.csv");
    const written = await readFile(out.path, "utf8");
    expect(written).toContain("Emma,Support");
    // Excel reads a UTF-8 CSV as the local codepage without a BOM, mangling "Niccolò"
    // in a file we wrote ourselves.
    expect(written.charCodeAt(0)).toBe(0xfeff);
  });

  it("never overwrites yesterday's export — it de-duplicates the name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crewpoppy-dl-"));
    const a = await saveCsvToDownloads("x", "crew.csv", dir);
    const b = await saveCsvToDownloads("y", "crew.csv", dir);
    const c = await saveCsvToDownloads("z", "crew.csv", dir);
    expect([a.savedAs, b.savedAs, c.savedAs]).toEqual(["crew.csv", "crew (2).csv", "crew (3).csv"]);
    expect(await readFile(a.path, "utf8")).toContain("x"); // the first is untouched
  });

  it("a filename can't escape the folder or hide the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crewpoppy-dl-"));
    const out = await saveCsvToDownloads("x", "../../.ssh/authorized_keys", dir);
    expect(out.path.startsWith(dir)).toBe(true);
    expect(out.savedAs).not.toContain("/");
    expect(out.savedAs.startsWith(".")).toBe(false);
  });
});

describe("a broken file changes NOTHING", () => {
  const HEAD = "Name,Role,Instructions,Model,Monthly cap USD\n";

  it("collects one plain error per broken row and refuses to apply", async () => {
    const { client, rows } = fakeDdb();
    const csv = HEAD + "Emma,Support,Help.,m1,10\n,NoName,Help.,m1,10\nBob,,Help.,m1,banana\n";
    const plan = await planImport(client, "t", csv, NOW);
    expect(plan.errors.length).toBeGreaterThanOrEqual(3); // no name / no role / not-money
    await expect(applyImport(client, "t", plan, NOW)).rejects.toThrow(/must not be applied/);
    expect(rows).toHaveLength(0); // planning wrote nothing either
  });

  it("the same name twice is an error — names are how rows find agents", async () => {
    const { client } = fakeDdb();
    const csv = HEAD + "Emma,Support,Help.,m1,10\nemma,Sales,Sell.,m1,10\n";
    const plan = await planImport(client, "t", csv, NOW);
    expect(plan.errors[0]).toMatch(/appears twice/);
  });

  it("a missing required column is named, in the uploader's terms", async () => {
    const { client } = fakeDdb();
    const plan = await planImport(client, "t", "Name,Role\nEmma,Support\n", NOW);
    expect(plan.errors.join(" ")).toMatch(/missing the "instructions" column/);
  });

  it("stops at the row ceiling instead of quietly attempting it", async () => {
    const { client } = fakeDdb();
    const csv = HEAD + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `A${i},R,I.,m1,1\n`).join("");
    const plan = await planImport(client, "t", csv, NOW);
    expect(plan.errors[0]).toMatch(/ceiling/);
  });
});

describe("applying a clean plan", () => {
  it("creates the new, updates the matched, deletes nobody — and adds up the money", async () => {
    const { client, rows } = fakeDdb([row(emma)]);
    const csv =
      "Name,Role,Instructions,Model,Tools,Approvals,Monthly cap USD\n" +
      "Emma,Lead Researcher,Dig deeper.,m1,memory_read,email,3\n" +
      "Bob,Support,Answer politely.,m1,,phone,2\n";
    const plan = await planImport(client, "t", csv, NOW);
    expect(plan.errors).toEqual([]);
    expect(plan.totalMonthlyCapUsd).toBe(5);
    const done = await applyImport(client, "t", plan, NOW);
    expect(done).toEqual({ created: 1, updated: 1 });

    const stored = rows.filter((r) => r.pk === AGENTS_PK) as unknown as AgentDef[];
    expect(stored).toHaveLength(2); // Emma updated in place, Bob added — nobody gone
    const emma2 = stored.find((a) => a.name === "Emma")!;
    expect(emma2.id).toBe("id-emma"); // same agent, so runs/spend/files still hers
    expect(emma2.role).toBe("Lead Researcher");
    expect(emma2.approvalChannel).toBeUndefined(); // "email" stored as absence (§15i)
    const bob = stored.find((a) => a.name === "Bob")!;
    expect(bob.approvalChannel).toBe("phone");
    expect(bob.caps.monthlySpendCapUsd).toBe(2);
  });

  it("tool names not in the catalogue are dropped by the same sanitiser the editor uses", async () => {
    const { client, rows } = fakeDdb();
    const csv =
      "Name,Role,Instructions,Model,Tools\nEve,QA,Test.,m1,memory_read launch_missiles\n";
    const plan = await planImport(client, "t", csv, NOW);
    await applyImport(client, "t", plan, NOW);
    expect((rows[0] as unknown as AgentDef).tools).toEqual(["memory_read"]);
  });
});
