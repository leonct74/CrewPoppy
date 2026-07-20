import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";

/**
 * The scoped destructive control (AGENTS.md §4). Removing CrewPoppy wipes its whole
 * footprint, so it earns the full ceremony:
 *
 *  - two distinct steps — the button opens a dialog, a second action destroys;
 *  - the blast radius is named in plain language, not "Are you sure?";
 *  - type-to-confirm arms the button, so it can't happen on autopilot;
 *  - Cancel is focused and the danger button is not the easy default, so a stray
 *    Enter or double-click can't destroy anything.
 *
 * DESIGN §3b: once agents exist, this dialog must offer the Crew Pack export FIRST —
 * "Download your Crew Pack before removing everything?" — so a teardown can never
 * silently erase what a crew has learned. That lands with the export itself (P1+);
 * the walking skeleton has no agent data to save yet.
 */
const CONFIRM_WORD = "CrewPoppy";

export function RemovePanel(props: { disabled?: boolean; onRemove: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Tolerate stray whitespace (e.g. an autocorrect trailing space) but require the exact word.
  const matches = typed.trim() === CONFIRM_WORD;

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTyped("");
    setErr(null);
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await props.onRemove();
      close();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-2">
      <h2 className="section-title">Remove CrewPoppy</h2>
      <div className="spread">
        <p className="muted" style={{ margin: 0, maxWidth: "46ch" }}>
          Deletes everything CrewPoppy made in your AWS account — your agents, everything they've
          learned, and every file they've made. Your AWS account itself isn't touched.
        </p>
        <button className="btn btn-danger" disabled={props.disabled} onClick={() => setOpen(true)}>
          Remove…
        </button>
      </div>

      {open && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="remove-title">
          <div className="modal stack">
            <h3 id="remove-title" style={{ margin: 0 }}>
              Remove CrewPoppy from your AWS account?
            </h3>
            <p style={{ margin: 0 }}>This deletes, permanently:</p>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>every agent — their instructions, their memory, everything they've learned</li>
              <li>their workspace — every file and result they've produced</li>
              <li>the record of every run, and everything else CrewPoppy created to work</li>
            </ul>
            <p style={{ margin: 0 }}>
              <strong>This can't be undone.</strong> You can set CrewPoppy up again later, but your
              crew comes back knowing nothing.
            </p>
            <label className="field" style={{ margin: 0 }}>
              <span>
                To switch on the button below, type <strong>{CONFIRM_WORD}</strong> here:
              </span>
              <input
                className="input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label={`Type ${CONFIRM_WORD} to confirm`}
              />
              {typed.length > 0 &&
                (matches ? (
                  <small style={{ color: "var(--poppy-ok)", fontSize: 12 }}>Match — the button is now on.</small>
                ) : (
                  <small className="muted" style={{ fontSize: 12 }}>
                    Doesn't match yet — type <strong>{CONFIRM_WORD}</strong> exactly (capital C and P).
                  </small>
                ))}
            </label>
            {err && <div className="banner err">{err}</div>}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" ref={cancelRef} onClick={close} disabled={busy}>
                Cancel
              </button>
              <Button
                className="btn btn-danger"
                disabled={!matches}
                busyLabel="Removing…"
                title={matches ? undefined : `Type ${CONFIRM_WORD} above to switch this on`}
                onClick={remove}
              >
                Remove everything
              </Button>
            </div>
            {!matches && !busy && (
              <p className="muted" style={{ margin: 0, fontSize: 12, textAlign: "right" }}>
                The button turns on once the name matches.
              </p>
            )}
            {busy && (
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                This can take a couple of minutes. It keeps going even if you leave this tab.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
