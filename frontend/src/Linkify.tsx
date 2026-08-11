// Turn the addresses in a chat message into things you can actually click.
//
// Why this exists: an agent that can read the web (DESIGN §4e) answers with the page it
// read — a fare and where to buy it. Printed as plain text that is a URL you have to
// select, copy and paste somewhere else, which is not an answer anyone wants to work with
// (founder, 2026-08-03: "so the user can actually press the link and purchase the ticket").
//
// 🪤 NOT <a href target="_blank">. A poppy's frontend runs in a SANDBOXED frame that
// cannot open an OS window, so a normal link silently does nothing — the same trap that
// killed blob downloads here. Every external address goes through host.openExternal,
// which is what ModelsCard and the feedback pane already do.
import { host } from "./host";

/**
 * Matches http(s) addresses in running text.
 *
 * The trailing-punctuation rule is the fiddly part and it is deliberate: a sentence
 * usually ends "…see https://example.com/x." and the full stop is the sentence's, not the
 * address's. Brackets are excluded too, because web_fetch writes links as `words [url]`.
 */
const URL_RE = /https?:\/\/[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?]/gi;

/** Long addresses are shown shortened — the whole thing is still what gets opened. */
function shorten(url: string): string {
  if (url.length <= 60) return url;
  try {
    const u = new URL(url);
    const tail = (u.pathname + u.search).replace(/^\//, "");
    return tail.length > 28 ? `${u.hostname}/${tail.slice(0, 25)}…` : `${u.hostname}/${tail}`;
  } catch {
    return `${url.slice(0, 57)}…`;
  }
}

export function Linkify({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // A fresh regex each call: /g state on a module-level literal is shared, and a stray
  // lastIndex would make the SECOND message on screen render differently from the first.
  const re = new RegExp(URL_RE.source, "gi");

  while ((m = re.exec(text)) !== null) {
    const url = m[0];
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <button
        key={`${m.index}-${url}`}
        type="button"
        className="msg-link"
        title={url}
        onClick={() => void host.openExternal(url)}
      >
        {shorten(url)}
      </button>,
    );
    last = m.index + url.length;
  }
  if (!out.length) return <>{text}</>;
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
