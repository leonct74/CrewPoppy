// Getting a file from the backend onto the owner's disk.
//
// The host serves this frontend at `<broker-origin>/ext-ui/<poppy-id>/…` and exposes a
// narrow passthrough on the SAME origin: `GET /ext-dl/<poppy-id>/local-download/<token>`
// is proxied to our backend's `GET /local-download/:token` and nothing else. The backend's
// port never appears anywhere — the URL is derived from where we are running. The host
// opens it in the system browser (`host.openExternal`), which sees
// `Content-Disposition: attachment` and saves the file the ordinary way.
//
// Pure, so it can be unit-tested without a window: pass `location.href` in.

/**
 * The URL the system browser should fetch for a one-shot download token, or null when this
 * page isn't being served by the host (there is then nobody to proxy the request).
 */
export function downloadUrlFor(token: string, href: string): string | null {
  let here: URL;
  try {
    here = new URL(href);
  } catch {
    return null;
  }
  // `location.origin` reads "null" in a sandboxed frame — build from the parsed href.
  const m = here.pathname.match(/^\/ext-ui\/([^/]+)\//);
  if (!m) return null;
  return `${here.protocol}//${here.host}/ext-dl/${m[1]}/local-download/${encodeURIComponent(token)}`;
}
