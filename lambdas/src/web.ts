// Reading the public web, on an agent's behalf (DESIGN §4e, §4f).
//
// Deliberately its own module with no AWS in it: everything here is decidable from a URL
// and some bytes, so it is unit-testable without a single mock, and the security-relevant
// parts can be read on one screen.
//
// The posture, in one line: an agent may READ a public page and the result is DATA. It
// cannot POST, cannot choose headers, cannot reach the private network, and cannot hand
// the model a megabyte of minified JavaScript.
//
// 🪤 The measured trap (DESIGN §4f). Google Flights' raw HTML carries fares inside
// AF_initDataCallback script blobs — 1.9 MB of them. Returning raw HTML would be ~500k
// tokens for one page, past the context window and past a month's spend cap in a single
// tool call. The SAME page, script-stripped, is 60,906 characters and contains every fare
// in readable text. That is why this module always extracts text and never returns markup.

import { lookup } from "node:dns/promises";

/**
 * Text handed back to the model, per fetch.
 *
 * Chosen by measurement, not taste (DESIGN §4f): a Google Flights search renders to 60,906
 * characters of text, and the 29 fares are all present within the first 40,000 — the first
 * appears at character 2,508. So 40k captures the whole answer for the use case that
 * motivated the tool, at roughly 10k tokens.
 *
 * ⚠️ That is HALF the default maxTokensPerRun (20,000, shared/src/types.ts). An agent given
 * this tool wants its per-run token cap raised, or two fetches will trip the guardrail
 * mid-run. The editor already exposes the cap; the capability note says so in words.
 */
export const MAX_TEXT_CHARS = 40_000;

/** Raw bytes read before giving up. Well above any page worth reading as text. */
export const MAX_BYTES = 4_000_000;

/** Redirect hops followed. Every hop is re-checked; see followUp(). */
export const MAX_REDIRECTS = 5;

const TIMEOUT_MS = 15_000;

/**
 * A common browser User-Agent — a judgement call, and one that was MEASURED rather than
 * assumed, so state it plainly instead of dressing it up.
 *
 * The first version of this constant self-identified as CrewPoppy with a contact URL,
 * which is the polite convention. Google served it `/travel/flights/unsupported` — an
 * "unsupported browser" page with no results — while the identical request with an
 * ordinary Chrome string reached the real page. Self-identifying does not get a fetch
 * politely declined; it gets it silently given a worse page.
 *
 * So: an ordinary browser string. What that is NOT is a licence to escalate. One request
 * per call, no retries, no proxy rotation, no CAPTCHA solving, no cookie games, and a site
 * that answers 403 is reported to the model AS refusing (DESIGN §4f measured three of
 * eight doing exactly that) rather than worked around. If a future change adds any of
 * those, this comment is the one to revisit first — it is the line between fetching a page
 * a person asked for and scraping a site that said no.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface WebFetchResult {
  ok: boolean;
  /** Extracted text on success; a sentence naming the actual problem on failure. */
  text: string;
  /** Every URL touched, first to last, so the owner sees where an agent went. */
  visited: string[];
  status?: number;
  truncated?: boolean;
}

/** Injectable so tests never touch DNS or the network. */
export interface WebDeps {
  resolve?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
}

// ── Address safety ─────────────────────────────────────────────────────────

/**
 * Is this address on the public internet?
 *
 * Refusing the private ranges is what stops an agent using the tool as a probe into
 * whatever else lives in the owner's account or network. Lambda has no IMDS endpoint to
 * steal credentials from, so this is defence in depth rather than the only thing standing
 * between a prompt injection and disaster — but it costs a few lines.
 */
export function isPublicAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (!addr) return false;

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is the classic way past a naive v4-only check.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  const v4 = mapped?.[1] ?? addr;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const octets = v4.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    // Defaulted rather than asserted: the length check above already guarantees four, and
    // a non-null assertion here would be the one place this file asks to be trusted.
    const [a = -1, b = -1] = octets;
    if (a === 0 || a === 127) return false; // this host / loopback
    if (a === 10) return false; // private
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 192 && b === 0) return false; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast + reserved
    return true;
  }

  if (addr === "::" || addr === "::1") return false;
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return false; // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return false; // link-local fe80::/10
  return addr.includes(":"); // some other IPv6
}

/**
 * Parse and vet a URL the MODEL supplied.
 *
 * Returns the reason on refusal rather than a boolean, because the model is told what was
 * wrong and can correct itself — a bare "no" costs a turn and teaches nothing.
 */
export async function checkUrl(raw: string, deps: WebDeps = {}): Promise<{ url: URL } | { refusal: string }> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { refusal: `"${raw.slice(0, 80)}" is not a valid web address. Give a full one, starting with https://` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { refusal: `Only http and https addresses can be fetched — not ${url.protocol.replace(":", "")}.` };
  }

  const resolver =
    deps.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));

  let addresses: string[];
  try {
    addresses = await resolver(url.hostname);
  } catch {
    return { refusal: `No such site: ${url.hostname} could not be found. Check the address.` };
  }
  if (!addresses.length) return { refusal: `No such site: ${url.hostname} could not be found.` };

  // EVERY address must be public. A host resolving to one public and one private address
  // is exactly the shape of a rebinding attempt, so it is refused whole.
  if (!addresses.every(isPublicAddress)) {
    return { refusal: `${url.hostname} points inside a private network, so it can't be fetched.` };
  }
  return { url };
}

// ── HTML → text ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  euro: "€", pound: "£", yen: "¥", cent: "¢", copy: "©", reg: "®",
  hellip: "…", mdash: "—", ndash: "–", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', times: "×", middot: "·",
};

/** Numeric entities matter more than they look: &#8364; is how a lot of pages write €. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/**
 * Links kept per page. A navigation bar alone can carry a hundred, and every one costs
 * tokens the owner pays for, so this is a budget rather than a target.
 */
export const MAX_LINKS = 80;

/** Absolute http(s) form of an href, or null if it is not somewhere a person can go. */
function absoluteHref(href: string, base?: string): string | null {
  const raw = decodeEntities(href.trim());
  if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * What the model actually receives.
 *
 * Scripts and styles go FIRST and completely — see the trap at the top of this file. Block
 * elements become line breaks so a price list does not arrive as one unreadable paragraph.
 *
 * LINKS ARE KEPT, as `words [https://...]`, inline where they appear (founder, 2026-08-03:
 * "it would be great if the response would include the links, so the user can actually press
 * the link"). Inline rather than gathered into a list at the end, because a bare list of URLs
 * separates every link from the thing it refers to — and the price it belongs to is the whole
 * point. `base` resolves relative hrefs; without it "/basket" is dropped rather than handed
 * over as something that cannot be opened.
 *
 * Each URL is annotated ONCE. Site navigation repeats the same twenty links in every page's
 * header and footer, and repeating them spends the budget on furniture.
 */
export function extractText(html: string, base?: string): string {
  let s = html.replace(/<(script|style|noscript|template|svg)[^>]*>.*?<\/\1>/gis, " ");
  s = s.replace(/<!--.*?-->/gis, " ");

  const seen = new Set<string>();
  s = s.replace(
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_m: string, dq: string, sq: string, bare: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const url = absoluteHref(dq ?? sq ?? bare ?? "", base);
      // An empty label means an icon or image link. A bare URL with no words around it
      // tells the model nothing and reads as noise, so keep neither.
      if (!url || !label) return label;
      if (seen.has(url) || seen.size >= MAX_LINKS) return label;
      seen.add(url);
      return `${label} [${url}]`;
    },
  );

  s = s.replace(/<(\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/gs, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ── The fetch ──────────────────────────────────────────────────────────────

/** Content types worth turning into text. Anything else is refused by name, not silently. */
function readableType(ct: string): boolean {
  const t = ct.toLowerCase().trim();
  if (!t) return true; // no content-type declared: try it, the extractor copes with junk
  return t.startsWith("text/") || t.includes("json") || t.includes("xml");
}

/**
 * Fetch one public URL and return its readable text.
 *
 * Redirects are followed MANUALLY — `redirect: "follow"` would let a public host bounce us
 * to 127.0.0.1 with no second opinion, which is the whole reason checkUrl exists. Each hop
 * is vetted exactly like the first, and every hop is recorded in `visited` so the
 * transcript shows where the agent actually went, not just where it meant to go.
 *
 * ⚠️ Honest limit: the address is checked, then fetch resolves the name again itself. A
 * host that changes its answer in between is not caught here. Closing that needs a custom
 * connect hook; it is not closed today, and the reason it is acceptable is that this Lambda
 * holds no credentials an SSRF could steal and Lambda exposes no metadata endpoint. Do not
 * upgrade this module's reach without revisiting that sentence.
 */
export async function webFetch(raw: string, deps: WebDeps = {}): Promise<WebFetchResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const visited: string[] = [];
  let target = raw;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await checkUrl(target, deps);
    if ("refusal" in checked) return { ok: false, text: checked.refusal, visited };
    visited.push(checked.url.toString());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(checked.url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
      });
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      return {
        ok: false,
        visited,
        text: aborted
          ? `${checked.url.hostname} took longer than ${TIMEOUT_MS / 1000} seconds to answer, so the fetch was given up.`
          : `Could not reach ${checked.url.hostname}. The site may be down or blocking automated requests.`,
      };
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, visited, status: res.status, text: `${checked.url.hostname} redirected without saying where.` };
      target = new URL(location, checked.url).toString();
      continue;
    }

    // The two failures DESIGN §4f actually measured, each named so the agent can tell the
    // owner something true instead of inventing a reason for an empty string.
    if (res.status === 403 || res.status === 401 || res.status === 429) {
      return {
        ok: false, visited, status: res.status,
        text: `${checked.url.hostname} refused an automated request (HTTP ${res.status}). This site only serves real browsers. Tell your owner it can't be read, and suggest a different source.`,
      };
    }
    if (!res.ok) {
      return { ok: false, visited, status: res.status, text: `${checked.url.hostname} answered HTTP ${res.status}.` };
    }

    const ctype = res.headers.get("content-type") ?? "";
    if (ctype && !readableType(ctype)) {
      return {
        ok: false, visited, status: res.status,
        text: `That address is ${ctype.split(";")[0]}, which isn't readable text. Only web pages and text can be fetched.`,
      };
    }

    const body = await readCapped(res);
    const text = extractText(body, checked.url.toString());

    // Measured, not guessed: a JavaScript-rendered page returns almost nothing here —
    // Ryanair yields 7 characters, tweakers 22 (DESIGN §4f). Returning "" invites the model
    // to invent what it "must have" said, so say what happened instead.
    if (text.length < 200 && body.length > 1000) {
      return {
        ok: false, visited, status: res.status,
        text: `${checked.url.hostname} builds its page inside a browser, so a plain fetch returns no readable content. Tell your owner this page can't be read this way, and suggest a source that publishes plain pages.`,
      };
    }

    const truncated = text.length > MAX_TEXT_CHARS;
    return {
      ok: true, visited, status: res.status, truncated,
      text: truncated ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[…truncated: ${text.length - MAX_TEXT_CHARS} more characters]` : text,
    };
  }

  return { ok: false, visited, text: `Too many redirects (more than ${MAX_REDIRECTS}).` };
}

/** Read the body but stop at MAX_BYTES — a hostile or careless URL must not exhaust memory. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c.subarray(0, Math.min(c.byteLength, total - at)), at);
    at += c.byteLength;
    if (at >= total) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}
