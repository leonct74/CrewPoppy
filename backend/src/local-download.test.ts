// The one-shot file handoff (see local-download.ts). The backend is CONFINED and can't
// write the owner's Downloads folder — so these pin the contract that replaced it:
// stage → exactly one take → gone; expiry; a filename that can't escape or hide; and
// the two details that make the file open correctly once it lands (BOM, UTF-8 name).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_DOWNLOAD_TTL_MS, contentDisposition, csvBytes, csvFile, safeFilename, stageDownload, takeDownload,
} from "./local-download";

describe("a staged file is fetched exactly once", () => {
  it("round-trips the bytes, name and type, then is gone", () => {
    const { token, filename } = stageDownload({
      filename: "crewpoppy-agents.csv",
      contentType: "text/csv; charset=utf-8",
      bytes: Buffer.from("Name,Role\r\nEmma,Support\r\n"),
    });
    expect(token).toMatch(/^[0-9a-f-]{36}$/); // a UUID — unguessable
    expect(filename).toBe("crewpoppy-agents.csv");

    const first = takeDownload(token);
    expect(first?.filename).toBe("crewpoppy-agents.csv");
    expect(first?.contentType).toBe("text/csv; charset=utf-8");
    expect(first?.bytes.toString("utf8")).toContain("Emma,Support");

    expect(takeDownload(token)).toBeNull(); // single-use
  });

  it("an unknown token is null, not a crash", () => {
    expect(takeDownload("nope")).toBeNull();
    expect(takeDownload("")).toBeNull();
  });

  it("two exports get two different tokens and don't see each other's bytes", () => {
    const a = stageDownload({ filename: "a.csv", contentType: "text/csv", bytes: Buffer.from("A") });
    const b = stageDownload({ filename: "b.csv", contentType: "text/csv", bytes: Buffer.from("B") });
    expect(a.token).not.toBe(b.token);
    expect(takeDownload(b.token)?.bytes.toString()).toBe("B");
    expect(takeDownload(a.token)?.bytes.toString()).toBe("A");
  });
});

describe("an unclaimed file expires", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is gone after the TTL", () => {
    const { token } = stageDownload({ filename: "x.csv", contentType: "text/csv", bytes: Buffer.from("x") });
    vi.advanceTimersByTime(LOCAL_DOWNLOAD_TTL_MS - 1);
    expect(takeDownload(token)).not.toBeNull(); // still there just before
  });

  it("the default TTL is a minute — long enough for the browser to open, short enough to not linger", () => {
    const { token } = stageDownload({ filename: "x.csv", contentType: "text/csv", bytes: Buffer.from("x") });
    vi.advanceTimersByTime(LOCAL_DOWNLOAD_TTL_MS + 1);
    expect(takeDownload(token)).toBeNull();
  });

  it("honours a custom TTL", () => {
    const { token } = stageDownload({ filename: "x.csv", contentType: "text/csv", bytes: Buffer.from("x") }, 10);
    vi.advanceTimersByTime(11);
    expect(takeDownload(token)).toBeNull();
  });
});

describe("the filename the browser is told", () => {
  it("can't escape a folder or hide the file", () => {
    expect(safeFilename("../../.ssh/authorized_keys")).not.toContain("/");
    expect(safeFilename("../../.ssh/authorized_keys").startsWith(".")).toBe(false);
    expect(safeFilename("..\\..\\evil.csv")).not.toContain("\\");
    expect(safeFilename("")).toBe("download");
    expect(safeFilename("crewpoppy-agents.csv")).toBe("crewpoppy-agents.csv");
  });

  it("is applied when staging, so the take side never sees a raw name", () => {
    const { token, filename } = stageDownload({
      filename: "../x.csv", contentType: "text/csv", bytes: Buffer.from("x"),
    });
    expect(filename).toBe("__x.csv"); // the slash → "_", then the leading ".." → "_"
    expect(takeDownload(token)?.filename).toBe(filename);
  });

  it("Content-Disposition carries an ASCII-safe name AND the UTF-8 one", () => {
    const h = contentDisposition('Niccolò "crew".csv');
    expect(h.startsWith("attachment; ")).toBe(true);
    expect(h).toContain('filename="Niccolò _crew_.csv"'); // quotes can't break the header
    expect(h).toContain("filename*=UTF-8''Niccol%C3%B2%20%22crew%22.csv");
    expect(h).not.toMatch(/[\r\n]/); // no header injection
  });
});

describe("the CSV bytes open correctly in Excel", () => {
  it("start with a UTF-8 BOM — without it Excel mangles 'Niccolò' in our own export", () => {
    const bytes = csvBytes("Name\r\nNiccolò\r\n");
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8").slice(1)).toBe("Name\r\nNiccolò\r\n");
  });

  it("csvFile sets the type the browser and Excel both recognise", () => {
    const f = csvFile("a,b\r\n", "crewpoppy-agents.csv");
    expect(f.contentType).toBe("text/csv; charset=utf-8");
    expect(f.filename).toBe("crewpoppy-agents.csv");
    expect(f.bytes.toString("utf8").charCodeAt(0)).toBe(0xfeff);
  });
});
