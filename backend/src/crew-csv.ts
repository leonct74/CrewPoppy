// The crew as a spreadsheet (founder, 2026-08-01): download every agent as one CSV —
// which is also the template — edit or mass-produce rows in Excel, upload to create
// hundreds in one go.
//
// The contract that keeps a re-upload harmless:
//  - rows MATCH BY NAME (case-insensitive): an existing name updates that agent, a new
//    name creates one, and an import never deletes anything;
//  - the whole file is validated first and applied only if every row is clean —
//    "347 agents made it, 3 didn't" leaves a crew nobody can reason about;
//  - every row goes through the same saveAgent sanitisers as the editor, so a
//    spreadsheet can't store anything the form couldn't.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { sanitiseSchedule, type AgentDef, type AgentSchedule } from "@crewpoppy/shared";
import { listAgents, saveAgent, type AgentInput } from "./agents";

/** Ceiling per upload. Above this the browser and the table both still cope — the OWNER doesn't. */
export const MAX_IMPORT_ROWS = 500;

/** Column order of the export; import matches HEADERS (case-insensitive), not positions. */
const COLUMNS = [
  "Name", "Role", "Instructions", "Model", "Tools", "Email address",
  "Open inbox", "Approvals", "Monthly cap USD", "Avatar", "Schedule",
] as const;

// ---------------------------------------------------------------- CSV plumbing

/** Quote one CSV field. Instructions hold commas, quotes and real newlines — all legal inside quotes. */
const quote = (v: string) => (/[",;\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Parse CSV text into rows of fields. Handles quoted fields, "" escapes, CRLF, a BOM —
 * and DETECTS the delimiter from the header line, because "CSV" is three things:
 *  - commas, the classic;
 *  - SEMICOLONS, which is what Excel writes in half of Europe (including the founder's
 *    locale) — mis-splitting an Italian user's own export into one giant column is not
 *    an acceptable failure mode;
 *  - TABS, which is what the clipboard holds when you select cells in Excel and copy,
 *    so "paste it here" works with no file at all.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const header = src.slice(0, src.indexOf("\n") === -1 ? src.length : src.indexOf("\n"));
  const count = (ch: string) => header.split(ch).length - 1;
  const delim = ([";", "\t", ","] as const).reduce((best, ch) => (count(ch) > count(best) ? ch : best), ",");

  const rows: string[][] = [];
  let field = "", row: string[] = [], inQuotes = false;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) endField();
    else if (c === "\n") { if (field.endsWith("\r")) field = field.slice(0, -1); endRow(); }
    else field += c;
  }
  if (field !== "" || row.length > 0) endRow();
  // Excel pads with fully-empty trailing lines; they are not agents.
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

// ---------------------------------------------------------------- export

/** The crew as CSV — or, with no agents yet, the template with one example row to replace. */
export function crewToCsv(agents: AgentDef[]): string {
  const rows = agents.length
    ? agents.map((a) => [
        a.name,
        a.role,
        a.instructions,
        a.modelId,
        (a.tools ?? []).join(" "),
        a.emailFrom ?? "",
        a.openInbox ? "yes" : "no",
        a.approvalChannel === "phone" ? "phone" : "email",
        String(a.caps.monthlySpendCapUsd),
        a.avatar ?? "",
        a.schedule ? JSON.stringify(a.schedule) : "",
      ])
    : [[
        "Example Emma (replace this row)",
        "Research Assistant",
        "Be concise. Research what you're asked and answer in writing.",
        "", // model left empty on purpose: the error message tells the uploader where the ids are
        "", "", "no", "email", "10", "", "",
      ]];
  return [COLUMNS as readonly string[], ...rows]
    .map((r) => r.map((f) => quote(String(f))).join(","))
    .join("\r\n") + "\r\n";
}

/**
 * Write the file the OWNER asked for into their Downloads folder, and report where it
 * landed.
 *
 * 🪤 The frontend CANNOT download anything itself. The host renders every poppy in a
 * SANDBOXED frame, and a sandbox without `allow-downloads` makes `<a download>` and
 * blob: URLs do exactly nothing — no error, no file, a dead button (founder, live,
 * 2026-08-01; MailPoppy hit the same wall in its webview and solved it the same way).
 * So the bytes are written HERE, by the local sidecar, which is an ordinary process on
 * the user's own machine. No browser window, no handoff, no token.
 *
 * Names are de-duplicated ("crewpoppy-agents (2).csv") and never overwritten: an export
 * is a snapshot, and silently replacing yesterday's is a way to lose work.
 */
export async function saveCsvToDownloads(
  csv: string,
  filename: string,
  dir = join(homedir(), "Downloads"),
): Promise<{ savedAs: string; path: string }> {
  // Base name only — no separators (traversal), no leading dot (hidden file).
  const cleaned = (filename || "crew.csv").replace(/[/\\]/g, "_").replace(/^\.+/, "_") || "crew.csv";
  await mkdir(dir, { recursive: true });
  const dot = cleaned.lastIndexOf(".");
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  let target = join(dir, cleaned);
  for (let n = 2; existsSync(target); n++) target = join(dir, `${stem} (${n})${ext}`);
  // BOM: Excel reads a UTF-8 CSV as the local codepage without it, so an agent called
  // "Niccolò" comes back mangled — from OUR OWN export.
  await writeFile(target, "﻿" + csv, "utf8");
  return { savedAs: target.slice(dir.length + 1), path: target };
}

// ---------------------------------------------------------------- import

export interface ImportPlan {
  /** Valid, apply-ready inputs, keyed by the id they will be saved under. */
  saves: { id: string; existing: boolean; input: AgentInput }[];
  created: number;
  updated: number;
  /** The money, added up BEFORE anything happens (AGENTS.md §9). */
  totalMonthlyCapUsd: number;
  /** One line per broken row. A non-empty list means NOTHING will be applied. */
  errors: string[];
}

const HEADER_KEYS = COLUMNS.map((c) => c.toLowerCase());

/** Validate a whole CSV against the live crew. Pure planning — writes nothing. */
export async function planImport(
  ddb: DynamoDBDocumentClient,
  table: string,
  csv: string,
  now: string,
): Promise<ImportPlan> {
  const errors: string[] = [];
  const rows = parseCsv(csv);
  if (rows.length < 2) return { saves: [], created: 0, updated: 0, totalMonthlyCapUsd: 0, errors: ["The file has no agent rows — download the spreadsheet for the expected columns."] };

  // Header → column index, case-insensitive, unknown columns ignored.
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = new Map<string, number>();
  for (const key of HEADER_KEYS) {
    const i = header.indexOf(key);
    if (i !== -1) col.set(key, i);
  }
  for (const required of ["name", "role", "instructions", "model"]) {
    if (!col.has(required)) errors.push(`The file is missing the "${required}" column — download the spreadsheet for the expected columns.`);
  }
  if (rows.length - 1 > MAX_IMPORT_ROWS) errors.push(`That's ${rows.length - 1} rows — the ceiling is ${MAX_IMPORT_ROWS} per upload. Split the file.`);
  if (errors.length) return { saves: [], created: 0, updated: 0, totalMonthlyCapUsd: 0, errors };

  const existing = await listAgents(ddb, table, now);
  const byName = new Map(existing.map((a) => [a.name.trim().toLowerCase(), a]));

  const saves: ImportPlan["saves"] = [];
  const seen = new Set<string>();
  let created = 0, updated = 0, totalCap = 0;

  for (let n = 1; n < rows.length; n++) {
    const at = (key: string) => (col.has(key) ? (rows[n]![col.get(key)!] ?? "").trim() : "");
    const line = `Row ${n + 1}`;
    const name = at("name");
    if (!name) { errors.push(`${line}: no name.`); continue; }
    const nameKey = name.toLowerCase();
    if (seen.has(nameKey)) { errors.push(`${line}: "${name}" appears twice — names are how rows match agents, so each may appear once.`); continue; }
    seen.add(nameKey);
    if (!at("role")) errors.push(`${line} (${name}): no role.`);
    if (!at("instructions")) errors.push(`${line} (${name}): no instructions.`);
    if (!at("model")) errors.push(`${line} (${name}): no model id. Copy one from an exported agent, or from the Models card.`);

    const capRaw = at("monthly cap usd");
    const cap = capRaw === "" ? 10 : Number(capRaw.replace(",", ".")); // 2,50 is how Excel-Europe writes 2.50
    if (!Number.isFinite(cap) || cap <= 0) errors.push(`${line} (${name}): "${capRaw}" isn't a monthly cap in dollars.`);

    const openRaw = at("open inbox").toLowerCase();
    if (openRaw && !["yes", "no", "true", "false", ""].includes(openRaw)) errors.push(`${line} (${name}): open inbox must be yes or no.`);
    const approvalsRaw = at("approvals").toLowerCase();
    if (approvalsRaw && !["email", "phone"].includes(approvalsRaw)) errors.push(`${line} (${name}): approvals must be email or phone.`);

    let schedule: AgentSchedule | null = null;
    const schedRaw = at("schedule");
    if (schedRaw) {
      try {
        schedule = sanitiseSchedule(JSON.parse(schedRaw)) ?? null;
        if (!schedule) errors.push(`${line} (${name}): the schedule isn't one this crew understands — copy it from an exported agent.`);
      } catch {
        errors.push(`${line} (${name}): the schedule column isn't valid JSON — copy it from an exported agent.`);
      }
    }

    const match = byName.get(nameKey);
    if (match) updated++; else created++;
    totalCap += Number.isFinite(cap) && cap > 0 ? cap : 0;
    saves.push({
      id: match?.id ?? randomUUID(),
      existing: !!match,
      input: {
        name,
        role: at("role"),
        instructions: at("instructions"),
        modelId: at("model"),
        // Tools are space-separated names; saveAgent drops anything not in the catalogue.
        tools: at("tools").split(/\s+/).filter(Boolean),
        emailFrom: at("email address"),
        openInbox: ["yes", "true"].includes(openRaw),
        approvalChannel: approvalsRaw === "phone" ? "phone" : "email",
        avatar: at("avatar"),
        schedule,
        caps: { monthlySpendCapUsd: cap },
      },
    });
  }

  return { saves, created, updated, totalMonthlyCapUsd: totalCap, errors };
}

/** Apply a clean plan. Refuses a dirty one — the caller shows the errors instead. */
export async function applyImport(
  ddb: DynamoDBDocumentClient,
  table: string,
  plan: ImportPlan,
  now: string,
): Promise<{ created: number; updated: number }> {
  if (plan.errors.length) throw new Error("This plan has errors and must not be applied.");
  for (const s of plan.saves) await saveAgent(ddb, table, s.id, s.input, now);
  return { created: plan.created, updated: plan.updated };
}
