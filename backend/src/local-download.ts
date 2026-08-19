// One-shot file handoff: how a file made by this backend reaches the owner's disk.
//
// The backend is CONFINED (extension.json `backend.isolation: "strict"`): Node's
// permission model lets it read its own install folder and write only the host's data
// folder and the OS temp dir. `~/Downloads` is off-limits by the runtime, not by
// convention — so "write the file into Downloads and tell the user the name" (the
// 2026-08-01 design) is no longer possible, and must not be re-introduced.
//
// The frontend can't save a file either: it runs in a sandboxed frame inside a webview
// that ignores `<a download>` and blob: URLs (founder, live, 2026-08-01 — a dead button).
//
// What works, and is the host's sanctioned path: the backend keeps the bytes in memory
// under a random single-use token; the frontend asks the host to open
// `/ext-dl/<poppy-id>/local-download/<token>` in the SYSTEM BROWSER; the broker proxies
// that one route (and only that route) to our `GET /local-download/:token`; the browser
// sees `Content-Disposition: attachment` and saves the file the normal way. Nothing is
// written to disk by us, and the token dies on first use or after a minute.
import { randomUUID } from "node:crypto";

/** How long an unclaimed file waits before it is dropped. */
export const LOCAL_DOWNLOAD_TTL_MS = 60_000;

export interface StagedFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

type Pending = StagedFile & { timer: NodeJS.Timeout };

const pending = new Map<string, Pending>();

/**
 * Base name only — no path separators (traversal), no leading dot (hidden file), never
 * empty. Exported so the test can pin it.
 */
export function safeFilename(filename: string, fallback = "download"): string {
  return (filename || fallback).replace(/[/\\]/g, "_").replace(/^\.+/, "_") || fallback;
}

/**
 * Park a file for one fetch. Returns the token the frontend puts in the download URL.
 * `ttlMs` is a parameter only so the expiry can be tested without waiting a minute.
 */
export function stageDownload(file: StagedFile, ttlMs = LOCAL_DOWNLOAD_TTL_MS): { token: string; filename: string } {
  const token = randomUUID();
  const filename = safeFilename(file.filename);
  const timer = setTimeout(() => pending.delete(token), ttlMs);
  // Don't keep the process alive just for an unclaimed download.
  if (typeof timer.unref === "function") timer.unref();
  pending.set(token, { filename, contentType: file.contentType, bytes: file.bytes, timer });
  return { token, filename };
}

/** Claim a staged file. Single-use: the second call for the same token returns null. */
export function takeDownload(token: string): StagedFile | null {
  const item = pending.get(token);
  if (!item) return null;
  clearTimeout(item.timer);
  pending.delete(token);
  return { filename: item.filename, contentType: item.contentType, bytes: item.bytes };
}

/**
 * The `Content-Disposition` value for a staged file. Quote-escapes the ASCII form and adds
 * the RFC 5987 UTF-8 form, so "Niccolò.csv" survives the browser as well as the BOM
 * makes it survive Excel.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The CSV as the bytes a spreadsheet opens correctly — see {@link csvBytes}. */
export function csvFile(csv: string, filename: string): StagedFile {
  return { filename, contentType: "text/csv; charset=utf-8", bytes: csvBytes(csv) };
}

/**
 * BOM-prefixed UTF-8. Excel reads a BOM-less UTF-8 CSV as the local codepage, so an agent
 * called "Niccolò" comes back mangled — from OUR OWN export.
 */
export function csvBytes(csv: string): Buffer {
  return Buffer.from("﻿" + csv, "utf8");
}
