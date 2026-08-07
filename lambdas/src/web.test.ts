// Tests for the web tool (DESIGN §4e, §4f).
//
// Nothing here touches the network or DNS: `webFetch` takes both as injectable deps, so
// every case below is deterministic. The cases are not invented — the awkward ones are
// the failures MEASURED against the real web on 2026-08-03 and recorded in §4f, plus the
// address tricks a private-network block exists to stop.

import { describe, expect, it, vi } from "vitest";
import { MAX_TEXT_CHARS, checkUrl, extractText, isPublicAddress, webFetch } from "./web";

const publicDns = async () => ["93.184.216.34"];

/** A Response without a real network. `body: null` sends webFetch down the res.text() path. */
function reply(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html", ...(init.headers ?? {}) },
  });
}

describe("isPublicAddress", () => {
  it("allows ordinary public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("refuses every private and special range", () => {
    const blocked = [
      "127.0.0.1", // loopback
      "0.0.0.0",
      "10.1.2.3", // RFC1918
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata, the classic SSRF target
      "100.64.0.1", // carrier-grade NAT
      "198.18.0.1", // benchmarking
      "224.0.0.1", // multicast
      "::1",
      "fc00::1", // unique local
      "fe80::1", // link-local
    ];
    for (const ip of blocked) expect(isPublicAddress(ip), ip).toBe(false);
  });

  it("refuses 172.16/12 without over-blocking its neighbours", () => {
    expect(isPublicAddress("172.15.0.1")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
    expect(isPublicAddress("172.20.0.1")).toBe(false);
  });

  it("sees through IPv4-mapped IPv6, which is how a v4-only check gets walked past", () => {
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
  });
});

describe("checkUrl", () => {
  it("refuses schemes that are not http(s)", async () => {
    for (const u of ["file:///etc/passwd", "ftp://x.example", "javascript:alert(1)"]) {
      const r = await checkUrl(u, { resolve: publicDns });
      expect("refusal" in r, u).toBe(true);
    }
  });

  it("refuses a host that resolves into the private network", async () => {
    const r = await checkUrl("https://internal.example", { resolve: async () => ["10.0.0.5"] });
    expect(r).toHaveProperty("refusal");
    expect((r as { refusal: string }).refusal).toContain("private network");
  });

  it("refuses a host with ONE private address among public ones — that shape is a rebinding attempt", async () => {
    const r = await checkUrl("https://mixed.example", { resolve: async () => ["93.184.216.34", "127.0.0.1"] });
    expect(r).toHaveProperty("refusal");
  });

  it("names a lookup failure instead of returning a bare no", async () => {
    const r = await checkUrl("https://nope.example", {
      resolve: async () => { throw new Error("ENOTFOUND"); },
    });
    expect((r as { refusal: string }).refusal).toContain("No such site");
  });
});

describe("extractText", () => {
  it("removes scripts entirely — the measured trap that would cost ~500k tokens a page", () => {
    const html = `<html><body><p>Fare €97</p><script>var junk="€1;".repeat(9999)</script></body></html>`;
    const out = extractText(html);
    expect(out).toContain("Fare €97");
    expect(out).not.toContain("junk");
    expect(out).not.toContain("repeat");
  });

  it("decodes the entities prices are actually written with", () => {
    expect(extractText("<p>&euro;97 &amp; &#8364;101 &#x20AC;120</p>")).toBe("€97 & €101 €120");
  });

  it("breaks block elements into lines so a price list is not one blob", () => {
    expect(extractText("<li>KLM €100</li><li>BA €121</li>")).toBe("KLM €100\nBA €121");
  });
});

describe("webFetch", () => {
  it("returns the page text, labelled by the address it came from", async () => {
    const r = await webFetch("https://example.com/x", {
      resolve: publicDns,
      fetchImpl: (async () => reply("<html><body><h1>Prices</h1><p>€97 round trip</p></body></html>")) as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("€97 round trip");
    expect(r.visited).toEqual(["https://example.com/x"]);
  });

  it("re-checks EVERY redirect hop — a public host must not bounce us to loopback", async () => {
    const resolve = async (host: string) => (host === "evil.example" ? ["93.184.216.34"] : ["127.0.0.1"]);
    const fetchImpl = (async (input: URL) => {
      if (String(input).includes("evil.example")) {
        return new Response("", { status: 302, headers: { location: "http://localhost.example/admin" } });
      }
      return reply("<p>secret</p>");
    }) as unknown as typeof fetch;

    const r = await webFetch("https://evil.example/start", { resolve, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("private network");
    expect(r.text).not.toContain("secret");
    // The attempt is still recorded: the transcript shows where it tried to go.
    expect(r.visited).toEqual(["https://evil.example/start"]);
  });

  it("records the whole redirect trail, because where it ENDED is what matters", async () => {
    const fetchImpl = (async (input: URL) => {
      if (String(input).endsWith("/a")) {
        return new Response("", { status: 301, headers: { location: "https://example.com/b" } });
      }
      return reply("<p>arrived</p>");
    }) as unknown as typeof fetch;
    const r = await webFetch("https://example.com/a", { resolve: publicDns, fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.visited).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("stops a redirect loop rather than following it forever", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 302, headers: { location: "https://example.com/loop" } })) as unknown as typeof fetch;
    const r = await webFetch("https://example.com/loop", { resolve: publicDns, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Too many redirects");
  });

  // The two failure modes §4f measured on the real web, each of which MUST produce a
  // sentence the agent can repeat to its owner — never an empty string the model then
  // invents a page around.
  it("names a refusal when a site blocks automated requests (measured: idealo, currys → 403)", async () => {
    const r = await webFetch("https://shop.example/x", {
      resolve: publicDns,
      fetchImpl: (async () => reply("<html>Access denied</html>", { status: 403 })) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("refused an automated request");
    expect(r.status).toBe(403);
  });

  it("names the browser-only case (measured: Ryanair 7 chars of text, tweakers 22)", async () => {
    const shell = `<html><head><title>x</title></head><body><div id="root"></div><script>${"x".repeat(4000)}</script></body></html>`;
    const r = await webFetch("https://spa.example/", {
      resolve: publicDns,
      fetchImpl: (async () => reply(shell)) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("builds its page inside a browser");
  });

  it("refuses content that is not text, by name", async () => {
    const r = await webFetch("https://example.com/f.zip", {
      resolve: publicDns,
      fetchImpl: (async () => reply("PK", { headers: { "content-type": "application/zip" } })) as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("isn't readable text");
  });

  it("truncates a long page and says so, so the model knows the answer may be cut off", async () => {
    const long = `<p>${"word ".repeat(30_000)}</p>`;
    const r = await webFetch("https://example.com/long", {
      resolve: publicDns,
      fetchImpl: (async () => reply(long)) as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("…truncated");
    expect(r.text.length).toBeLessThan(MAX_TEXT_CHARS + 200);
  });

  it("gives up on a slow site with a sentence rather than hanging the run", async () => {
    const fetchImpl = (async (_i: URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as unknown as typeof fetch;

    vi.useFakeTimers();
    const promise = webFetch("https://slow.example/", { resolve: publicDns, fetchImpl });
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await promise;
    vi.useRealTimers();

    expect(r.ok).toBe(false);
    expect(r.text).toContain("took longer than");
  });
});
