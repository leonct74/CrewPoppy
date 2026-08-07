// The mandatory Feedback panel (AGENTS.md §9a) — always the LAST thing in the poppy.
//
// We render the platform's own element rather than building a rating widget, a request form and a
// donate flow of our own: a user who installs three poppies must find the same four things in the
// same place. The element is vendored verbatim from the AgentsPoppy SDK (`npm run sync-feedback`;
// `npm run check-feedback` fails if the copy drifts).
import { useEffect, useRef } from "react";
import { host } from "./host";
import { defineFeedbackTab } from "./vendor/agentspoppy-feedback-tab";

/** This poppy's manifest id — what the rating is recorded against. */
const POPPY_ID = "com.crewpoppy.desktop";

/** Where a bug goes — the public issue tracker, mirroring `bugsUrl` in extension.json. */
const BUGS_URL = "https://github.com/leonct74/CrewPoppy/issues";

// The tab calls the AgentsPoppy feedback API itself; the only thing it needs from the host is
// `openExternal` (a sandboxed frame can't open an OS window), which our bridge already has.
defineFeedbackTab(host);

export function Feedback() {
  const slot = useRef<HTMLDivElement>(null);

  // Created imperatively so React never tries to reconcile the custom element's shadow DOM.
  useEffect(() => {
    const mount = slot.current;
    if (!mount || mount.firstChild) return;
    const el = document.createElement("agentspoppy-feedback");
    el.setAttribute("poppy", POPPY_ID);
    el.setAttribute("bugs", BUGS_URL);
    el.setAttribute("name", "CrewPoppy");
    mount.appendChild(el);
  }, []);

  return (
    <section className="stack">
      <h2 className="section-title">Feedback</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Tell us how CrewPoppy is doing. Your rating shows on the AgentsPoppy catalogue, and
        everything here is anonymous unless you choose to leave your email.
      </p>
      <div ref={slot} />
    </section>
  );
}
