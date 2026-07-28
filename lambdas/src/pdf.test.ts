import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { renderPdf } from "./pdf";

const INVOICE = `## Invoice CP-2026-014

Olly Digital · Amsterdam

| Item | Qty | Price |
|---|---|---|
| CrewPoppy onboarding | 1 | €450.00 |
| Agent setup workshop | 2 | €180.00 |

---

**Total due: €810.00** — payment within 14 days.

- IBAN: NL00 BANK 0123 4567 89
- Reference: CP-2026-014`;

const text = (pdf: Uint8Array) => Buffer.from(pdf).toString("latin1");

describe("the PDF renderer", () => {
  it("produces a structurally complete PDF", () => {
    const s = text(renderPdf(INVOICE, "Sales offer"));
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s).toContain("/Type /Catalog");
    expect(s).toContain("/BaseFont /Helvetica");
    expect(s).toContain("/BaseFont /Helvetica-Bold");
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    // Every page the tree claims exists as an object (\b keeps /Pages out of the match).
    const count = Number(/\/Count (\d+)/.exec(s)?.[1]);
    expect((s.match(/\/Type \/Page\b/g) ?? []).length).toBe(count);
  });

  it("renders the words that matter, with € surviving as WinAnsi", () => {
    const s = text(renderPdf(INVOICE));
    expect(s).toContain("Invoice CP-2026-014");
    expect(s).toContain("CrewPoppy onboarding");
    // € has no latin-1 slot; WinAnsi puts it at 0x80. If this fails, invoices say "?450".
    expect(s).toContain(`${String.fromCharCode(0x80)}450.00`);
    // Inline ** markers are stripped, never printed.
    expect(s).not.toContain("**");
  });

  it("escapes the characters that would break a PDF string", () => {
    const s = text(renderPdf("Price (net) is 50% \\ balance (gross) due"));
    expect(s).toContain("\\(net\\)");
    expect(s).toContain("\\\\");
  });

  it("flows long documents onto further pages instead of writing past the margin", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} of the offer.`).join("\n\n");
    const s = text(renderPdf(long));
    expect(Number(/\/Count (\d+)/.exec(s)?.[1])).toBeGreaterThan(1);
  });

  it("is deterministic — same input, same bytes", () => {
    const a = renderPdf(INVOICE, "Offer");
    const b = renderPdf(INVOICE, "Offer");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("writes a sample invoice for human inspection", () => {
    // Not an assertion — a fixture. Open it in Preview when the layout changes.
    writeFileSync("/tmp/crewpoppy-sample-invoice.pdf", renderPdf(INVOICE, "Sales offer"));
  });
});
