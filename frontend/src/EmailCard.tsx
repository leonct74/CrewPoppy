import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import type { OwnerEmail } from "./types";

/**
 * The one address your agents email you at (DESIGN §4c).
 *
 * It lives here, at install level, rather than on each agent — because it is the thing
 * an agent must NOT be able to choose. The "email you" tool has no recipient field at
 * all; this setting is the only thing that decides where its mail lands, which is what
 * makes "it can only ever reach you" a true statement rather than a hopeful one.
 *
 * We check the address against SES before saving. A setting that looks saved and then
 * silently bounces is the worst kind of failure: you find out days later, in the one
 * message that mattered.
 */
export function EmailCard(props: { onChanged?: (owner: OwnerEmail) => void }) {
  const [owner, setOwner] = useState<OwnerEmail | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const notify = props.onChanged;

  const load = useCallback(async () => {
    try {
      const o = await api.ownerEmail();
      setOwner(o);
      setDraft(o.email ?? "");
      notify?.(o);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!owner) return null;
  const showForm = editing || !owner.email;

  return (
    <div className="card stack">
      <div className="spread">
        <strong>Email</strong>
        {owner.email && (
          <span className={`badge ${owner.verified ? "ok" : "warn"}`}>
            <span className="dot" /> {owner.verified ? "Ready" : "Needs attention"}
          </span>
        )}
      </div>

      {!owner.email && (
        <p className="muted" style={{ margin: 0 }}>
          Set an address and your agents can email you — progress, questions, a draft they want
          approved. They can't choose where it goes: everything comes to this address, and to
          nobody else until you approve a message yourself.
        </p>
      )}

      {owner.email && !showForm && (
        <>
          <div className="spread">
            <span className="mono">{owner.email}</span>
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              Change…
            </button>
          </div>
          {owner.message && <div className="banner warn">{owner.message}</div>}
          {owner.verified && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Agents you've given "Email you" can write to this address. Anything addressed to
              anyone else stops and waits for you to approve it, word for word.
            </p>
          )}
        </>
      )}

      {showForm && (
        <>
          <label className="field" style={{ margin: 0 }}>
            <span>Where should your agents email you?</span>
            <input
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="you@yourdomain.com"
              autoComplete="off"
              spellCheck={false}
              aria-label="Your email address"
            />
            <small className="muted" style={{ fontSize: 12 }}>
              It has to be an address your AWS account has verified for sending — any mailbox you
              made in MailPoppy already is.
            </small>
          </label>
          {err && <div className="banner err">{err}</div>}
          <div className="row">
            <Button
              className="btn btn-primary"
              disabled={!draft.trim()}
              busyLabel="Checking with AWS…"
              onClick={async () => {
                setErr(null);
                try {
                  const saved = await api.setOwnerEmail(draft.trim());
                  setOwner(saved);
                  setEditing(false);
                  notify?.(saved);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Save address
            </Button>
            {owner.email && (
              <button
                className="btn"
                onClick={() => {
                  setEditing(false);
                  setDraft(owner.email ?? "");
                  setErr(null);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
