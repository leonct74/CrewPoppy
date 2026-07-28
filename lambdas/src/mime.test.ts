import { describe, expect, it } from "vitest";
import { buildRawEmail } from "./mime";

const pdf = new TextEncoder().encode("%PDF-1.4 fake bytes");
const base = {
  from: "Postie <marco@example.com>",
  to: "jane@customer.test",
  subject: "Your offer",
  body: "Hello Jane,\n\nthe offer is attached.\n\nPostie",
};

describe("raw email assembly", () => {
  it("builds a multipart message whose attachment survives a round trip", () => {
    const raw = Buffer.from(
      buildRawEmail({ ...base, attachment: { filename: "offer.pdf", content: pdf, contentType: "application/pdf" } }),
    ).toString("utf8");

    expect(raw).toContain("From: Postie <marco@example.com>");
    expect(raw).toContain("To: jane@customer.test");
    expect(raw).toContain(`Content-Type: application/pdf; name="offer.pdf"`);
    expect(raw).toContain(`Content-Disposition: attachment; filename="offer.pdf"`);

    // Decode the attachment part back out — the bytes must be EXACTLY what went in.
    const b64 = raw.split("Content-Transfer-Encoding: base64").pop()!.split("--")[0]!.replace(/\s/g, "");
    expect(Buffer.from(b64, "base64").equals(Buffer.from(pdf))).toBe(true);
  });

  it("stays a simple single-part message when there is nothing to attach", () => {
    const raw = Buffer.from(buildRawEmail(base)).toString("utf8");
    expect(raw).not.toContain("multipart/mixed");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
  });

  it("cannot be header-injected through the subject or the filename", () => {
    const raw = Buffer.from(
      buildRawEmail({
        ...base,
        subject: "Offer\r\nBcc: evil@attacker.test",
        attachment: { filename: 'off"er.pdf\r\nX-Evil: yes', content: pdf, contentType: "application/pdf" },
      }),
    ).toString("utf8");
    // The attack text may survive as INERT DATA inside a single header line — what must
    // never exist is a new line starting a new header.
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).not.toMatch(/\r\nX-Evil/);
    expect(raw).not.toContain('er.pdf"X'); // the quote can't be closed early either
  });

  it("encodes a non-ASCII subject instead of mangling it", () => {
    const raw = Buffer.from(buildRawEmail({ ...base, subject: "Offerta — €800" })).toString("utf8");
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});
