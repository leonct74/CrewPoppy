// The Templates tab — ready-made agent setups you can adopt and adapt (DESIGN §15l).
//
// The problem this solves is the blank instructions box: everything the product can do
// is downstream of writing a good brief, and "describe the job in a sentence or two"
// is only easy once you've seen a few that work. Each card here is one that HAS worked
// — every recipe in the catalogue is backed by a live run, and shipping one that fails
// on first contact would cost more trust than the empty box it replaced.
//
// The rule that shapes the UX (§15l): choosing a template FILLS THE EDITOR AND STOPS.
// The owner lands in the same granting ceremony as always, with everything visible and
// editable — a recipe suggests capabilities, it never grants them. The card is honest
// about what the agent will need ("Read web pages — without it, it cannot see prices"),
// so the ticks the owner meets in the editor are expected, not smuggled.
import { useEffect, useState } from "react";
import { api } from "./api";
import { Avatar } from "./avatars";
import type { Recipe, ToolCatalogue } from "./types";

export function Templates(props: {
  /** Hands the chosen recipe to the crew view, which opens the pre-filled editor. */
  onUse: (recipe: Recipe) => void;
  /** The deployment must exist first — an agent needs a home before it can be created. */
  ready: boolean;
}) {
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [catalogue, setCatalogue] = useState<ToolCatalogue | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listRecipes()
      .then((r) => setRecipes(r.recipes))
      .catch((e) => setErr((e as Error).message));
    void api.listTools().then(setCatalogue).catch(() => {});
  }, []);

  const labelFor = (tool: string) =>
    catalogue?.tools.find((t) => t.name === tool)?.label ?? tool;

  return (
    <div className="card stack">
      <div>
        <strong>Agent templates</strong>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Ready-made agents you can adopt as they are, or use as a starting point. Picking one
          fills in the whole setup — the job description, the abilities it needs, files and
          schedule — and <strong>you still review everything before it exists</strong>. Every
          template here has been run for real.
        </p>
      </div>

      {err && <div className="banner err">{err}</div>}
      {!recipes && !err && (
        <div className="row">
          <span className="spinner" /> <span className="muted">Loading templates…</span>
        </div>
      )}

      {!props.ready && recipes && (
        <div className="banner">
          Set up CrewPoppy on the “Your crew” tab first — an agent needs a home in your AWS
          account before it can be created.
        </div>
      )}

      <div className="tpl-grid">
        {(recipes ?? []).map((r) => (
          <div key={r.key} className="tpl-card stack">
            <div className="row" style={{ gap: 10 }}>
              <Avatar id={r.avatar} name={r.name} size={40} />
              <div>
                <strong>{r.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>{r.role}</div>
              </div>
            </div>

            <p style={{ margin: 0, fontSize: 13 }}>{r.blurb}</p>

            {/* The suggested ability set, in the same words as the editor's checkboxes —
                so what the owner sees pre-ticked there is exactly what the card said. */}
            <div className="tpl-chips">
              {r.tools.map((t) => (
                <span key={t} className="chip" style={{ fontSize: 11 }}>{labelFor(t)}</span>
              ))}
              {r.schedule && (
                <span className="chip" style={{ fontSize: 11 }}>
                  ⏱ {r.schedule.kind === "hourly" ? "Every hour" : r.schedule.kind === "daily" ? "Daily" : "Weekly"}
                </span>
              )}
            </div>

            {r.needs.length > 0 && (
              <ul className="tpl-needs">
                {r.needs.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}

            <div>
              <button
                className="btn btn-primary btn-sm"
                disabled={!props.ready}
                onClick={() => props.onUse(r)}
              >
                Use this template
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Templates are suggestions: rename the agent, rewrite its job, untick anything. Nothing
        exists in your AWS account until you press save in the editor.
      </p>
    </div>
  );
}
