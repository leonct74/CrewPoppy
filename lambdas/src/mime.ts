// Raw MIME assembly — how an email carries an attachment (DESIGN §4c/§4d).
//
// SES's Simple content type cannot attach files, so attaching means building the RFC 2822
// message ourselves. Hand-rolled for the same reason as pdf.ts: the shape is small and
// bounded — multipart/mixed, one text part, one attachment — and a MIME library is a
// dependency we'd trust with header injection instead of understanding it.
//
// EVERY body is base64-encoded, text included. That is not laziness: base64 output can
// never contain the boundary marker (after '=' padding only more '=' or a line break can
// follow, never '_'), which is what makes a FIXED boundary safe — and a fixed boundary
// keeps the bytes deterministic, same input → same message.

export interface MimeAttachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
}

const BOUNDARY = "=_crewpoppy_7f9c2e4a1b";
const CRLF = "\r\n";

/** Base64, folded to 76 columns as RFC 2045 requires. */
function b64(data: Uint8Array | string): string {
  const raw = (typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)).toString("base64");
  return raw.replace(/(.{76})/g, `$1${CRLF}`);
}

/** Header values must be one line of clean ASCII; anything else gets RFC 2047 encoding. */
function headerText(s: string): string {
  const clean = s.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** A filename inside a quoted header value can't be allowed to close the quote. */
function headerFilename(s: string): string {
  return s.replace(/["\\\r\n;]/g, "").slice(0, 120) || "attachment";
}

export function buildRawEmail(args: {
  from: string;
  to: string;
  subject: string;
  body: string;
  attachment?: MimeAttachment;
}): Uint8Array {
  const head = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${headerText(args.subject)}`,
    `MIME-Version: 1.0`,
  ];
  const textPart = [
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64(args.body),
  ].join(CRLF);

  if (!args.attachment) {
    return Buffer.from([...head, textPart].join(CRLF), "utf8");
  }

  const name = headerFilename(args.attachment.filename);
  const filePart = [
    `Content-Type: ${args.attachment.contentType}; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64(args.attachment.content),
  ].join(CRLF);

  return Buffer.from(
    [
      ...head,
      `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
      ``,
      `--${BOUNDARY}`,
      textPart,
      `--${BOUNDARY}`,
      filePart,
      `--${BOUNDARY}--`,
      ``,
    ].join(CRLF),
    "utf8",
  );
}
