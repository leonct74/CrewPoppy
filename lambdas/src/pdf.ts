// A small, honest PDF renderer (DESIGN §4d) — Markdown-lite in, a real PDF out.
//
// WHY HAND-ROLLED, NO LIBRARY: the founder's use case is offers and invoices — headings,
// paragraphs, bullet lists, tables, rules. That is a bounded typesetting problem, and the
// popular JS PDF packages drag optional browser dependencies (canvas, DOM) that fight the
// Lambda bundler. ~200 deterministic lines we fully control beats a megabyte we don't —
// the same reasoning as the hand-authored CloudFormation template (§2b).
//
// WHAT IT SPEAKS: PDF 1.4, the built-in Helvetica pair (no font embedding), WinAnsi
// encoding — so €, £, and typographic quotes work, which invoices genuinely need.
// Character widths are conservative estimates, so lines wrap slightly early rather than
// ever overflowing the page.
//
// THE INPUT is the Markdown subset the tool description promises the model:
//   # ## ###   headings          - or *   bullet items
//   | a | b |  table rows        |---|    after the first row makes it a header
//   ---        horizontal rule   blank    paragraph gap
// Inline *emphasis* markers are stripped, not rendered: a stray asterisk in an invoice
// is worse than no italics.

const PAGE_W = 595.28; // A4 portrait, in points
const PAGE_H = 841.89;
const MARGIN = 56;
const AVAIL = PAGE_W - 2 * MARGIN;

/** Conservative width-per-character estimate, in em. Wrapping early is the safe error. */
const EM_REGULAR = 0.52;
const EM_BOLD = 0.56;

/** WinAnsi has real slots for these; latin-1 alone would turn € into a '?'. */
const WINANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "‰": 0x89,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99,
};

function toWinAnsi(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code === 0x09) out += " ";
    else if (code < 0x20) continue;
    else if (code <= 0xff) out += ch;
    else if (WINANSI[ch] !== undefined) out += String.fromCharCode(WINANSI[ch]!);
    else out += "?";
  }
  return out;
}

function esc(s: string): string {
  return toWinAnsi(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Strip inline markers the renderer deliberately doesn't honour. */
function plain(s: string): string {
  return s.replace(/\*\*|__|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)|`/g, "").trimEnd();
}

function wrap(text: string, size: number, bold: boolean, avail: number): string[] {
  const charW = size * (bold ? EM_BOLD : EM_REGULAR);
  const maxChars = Math.max(8, Math.floor(avail / charW));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length <= maxChars) line = candidate;
    else {
      if (line) lines.push(line);
      // A single over-long word (a URL, an IBAN) is hard-split rather than overflowing.
      let rest = w;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

interface Style { size: number; bold: boolean; lead: number; before: number }
const BODY: Style = { size: 11, bold: false, lead: 15, before: 0 };
const H1: Style = { size: 19, bold: true, lead: 25, before: 10 };
const H2: Style = { size: 14.5, bold: true, lead: 20, before: 8 };
const H3: Style = { size: 12, bold: true, lead: 17, before: 6 };

/** Render Markdown-lite to PDF bytes. Pure and deterministic: same input, same bytes. */
export function renderPdf(body: string, title?: string): Uint8Array {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    pages.push(ops.join("\n"));
    ops = [];
    y = PAGE_H - MARGIN;
  };
  const need = (h: number) => {
    if (y - h < MARGIN) newPage();
  };
  const textLine = (s: string, style: Style, x = MARGIN) => {
    need(style.lead);
    y -= style.lead;
    ops.push(`BT /${style.bold ? "F2" : "F1"} ${style.size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${esc(s)}) Tj ET`);
  };
  const paragraph = (s: string, style: Style, x = MARGIN, avail = AVAIL) => {
    if (style.before) {
      need(style.before + style.lead);
      y -= style.before;
    }
    for (const line of wrap(s, style.size, style.bold, avail)) textLine(line, style, x);
  };
  const rule = () => {
    need(12);
    y -= 8;
    ops.push(`0.75 w 0.62 G ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`);
    y -= 4;
  };

  const table = (rows: string[][], headerRows: number) => {
    const cols = Math.max(...rows.map((r) => r.length));
    const longest = Array.from({ length: cols }, (_, c) =>
      Math.max(4, ...rows.map((r) => (r[c] ?? "").length)),
    );
    const totalChars = longest.reduce((a, b) => a + b, 0);
    const widths = longest.map((n) => Math.max(42, (n / totalChars) * AVAIL));
    const scale = AVAIL / widths.reduce((a, b) => a + b, 0);
    const colW = widths.map((w) => w * scale);
    const ROW_H = 17;

    const line = (yy: number) =>
      ops.push(`0.5 w 0.62 G ${MARGIN} ${yy.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${yy.toFixed(2)} l S`);

    need(ROW_H + 4);
    line(y - 2);
    rows.forEach((cells, i) => {
      need(ROW_H);
      y -= ROW_H;
      const bold = i < headerRows;
      let x = MARGIN;
      cells.forEach((cell, c) => {
        const w = colW[c] ?? 60;
        const maxChars = Math.max(3, Math.floor((w - 8) / (BODY.size * (bold ? EM_BOLD : EM_REGULAR))));
        const text = cell.length > maxChars ? `${cell.slice(0, maxChars - 1)}…` : cell;
        ops.push(`BT /${bold ? "F2" : "F1"} ${BODY.size} Tf 1 0 0 1 ${(x + 4).toFixed(2)} ${(y + 4.5).toFixed(2)} Tm (${esc(text)}) Tj ET`);
        x += w;
      });
      line(y);
    });
    y -= 4;
  };

  // ---- walk the input --------------------------------------------------------------
  if (title?.trim()) {
    paragraph(plain(title), H1);
    rule();
  }
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.trim();

    if (!line) {
      y -= 7;
      i += 1;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      let headerRows = 0;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = lines[i]!.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => plain(c.trim()));
        if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) {
          if (rows.length === 1) headerRows = 1; // the |---| convention
        } else rows.push(cells);
        i += 1;
      }
      if (rows.length) table(rows, headerRows);
      continue;
    }
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line)) rule();
    else if (line.startsWith("### ")) paragraph(plain(line.slice(4)), H3);
    else if (line.startsWith("## ")) paragraph(plain(line.slice(3)), H2);
    else if (line.startsWith("# ")) paragraph(plain(line.slice(2)), H1);
    else if (/^[-*]\s+/.test(line)) {
      paragraph(`• ${plain(line.replace(/^[-*]\s+/, ""))}`, BODY, MARGIN + 12, AVAIL - 12);
    } else paragraph(plain(line), BODY);
    i += 1;
  }
  newPage();

  // ---- assemble the file -----------------------------------------------------------
  // Fixed object layout: 1 catalog · 2 pages root · 3/4 fonts · then per page i:
  // 5+2i content, 6+2i page. Deterministic, so the content-addressed zip stays stable.
  const pageIds = pages.map((_, idx) => 6 + 2 * idx);
  const objs: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  ];
  for (const content of pages) {
    objs.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    // Ids are 1-based (index + 1), so at this moment `objs.length` IS the id of the
    // content stream just pushed — the page dict must point at it, not at itself.
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objs.length} 0 R >>`,
    );
  }

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, idx) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${idx + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
