// Pairing the phone (DESIGN §15h M1). The desktop shows a QR; the phone scans it —
// nobody types a pool id on glass, and the password inside the code is shown once,
// stored nowhere, and invalidated by simply pairing again.

import { useCallback, useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { api, type PairingPayload } from "./api";
import { Button } from "./Button";
import { host } from "./host";

/**
 * Where the phone app actually comes from (both stores approved 2026-08-12).
 *
 * The Apple link is the STOREFRONT-NEUTRAL form (`/app/id…`, no country segment): Apple
 * redirects it to the visitor's own country store, whereas the `/nl/` form the lookup API
 * hands back would send an Italian or American user to the wrong storefront.
 *
 * These open through `host.openExternal` — a poppy frontend is a sandboxed frame and a
 * plain <a target="_blank"> silently does nothing (the same trap that killed downloads).
 */
const APP_STORE = "https://apps.apple.com/app/id6796639369";
const PLAY_STORE = "https://play.google.com/store/apps/details?id=com.crewpoppy.mobile";

/**
 * The QR itself. Always dark-on-white whatever the app theme: phone cameras want
 * contrast, not aesthetics, and an inverted code scans unreliably.
 */
function Qr(props: { text: string }) {
  const qr = qrcode(0, "M");
  qr.addData(props.text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
  }
  return (
    <div style={{ background: "#fff", borderRadius: 12, padding: 16, alignSelf: "center", lineHeight: 0 }}>
      <svg viewBox={`0 0 ${n} ${n}`} width={232} height={232} role="img" aria-label="Pairing code">
        <path d={d} fill="#000" />
      </svg>
    </div>
  );
}

export function PhonePane(props: { onBack: () => void }) {
  const [status, setStatus] = useState<{ doorReady: boolean; paired: boolean } | null>(null);
  const [payload, setPayload] = useState<PairingPayload | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.mobileStatus());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  return (
    <div className="card stack">
      <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={props.onBack}>
        ← Your crew
      </button>
      <h3 className="section-title">CrewPoppy on your phone</h3>
      <p style={{ margin: 0 }}>
        The phone app talks directly to <strong>your own AWS</strong> — the same crew, the same
        approvals, nothing routed through anyone else. Chat with your agents, answer their
        questions and approve or stop work from wherever you are.
      </p>

      {/* The pane told people to "open the CrewPoppy app" without ever saying where to get
          it — obvious once both stores were live and someone had to go and find it. Placed
          BEFORE the pairing button, because installing is the step that comes first. */}
      <div className="stack" style={{ gap: 8 }}>
        <p className="muted" style={{ margin: 0 }}>
          Don't have it yet? It's free, and it's the same app on both:
        </p>
        <div className="spread" style={{ justifyContent: "flex-start", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => void host.openExternal(APP_STORE)}>
             App Store ↗
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void host.openExternal(PLAY_STORE)}>
            ▶ Google Play ↗
          </button>
        </div>
      </div>

      {err && <div className="banner err">{err}</div>}
      {!status && !err && <p className="muted">Checking your deployment…</p>}

      {status && !status.doorReady && (
        <div className="banner">
          Your deployment doesn't have the phone connection yet. Apply the update in the setup
          card above, then come back here.
        </div>
      )}

      {status?.doorReady && !payload && (
        <>
          {status.paired && (
            <p className="muted" style={{ margin: 0 }}>
              A phone is already connected. Pairing again shows a fresh code and signs the old
              one out — that's also the fix if you ever lose the phone.
            </p>
          )}
          <div className="spread">
            <Button
              className="btn btn-primary"
              busyLabel="Preparing…"
              onClick={async () => {
                try {
                  setPayload((await api.mobilePair()).payload);
                  setCopied(false);
                  setErr(null);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              {status.paired ? "Pair again (new code)" : "Show pairing code"}
            </Button>
            {status.paired && (
              <Button
                className="btn btn-ghost"
                busyLabel="Disconnecting…"
                onClick={async () => {
                  await api.mobileRevoke();
                  await refresh();
                }}
              >
                Disconnect phone
              </Button>
            )}
          </div>
        </>
      )}

      {payload && (
        <>
          <Qr text={JSON.stringify(payload)} />
          <p className="muted" style={{ margin: 0, textAlign: "center" }}>
            Open the CrewPoppy app on your phone and scan this code.
          </p>
          {/* The same secret, on the same screen, for hands that can't scan — the iOS
              SIMULATOR has no camera, and a phone camera "helpfully" opens the URL
              inside the code instead of showing the text. Copy, paste, done. */}
          <div style={{ alignSelf: "center" }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify(payload));
                setCopied(true);
              }}
            >
              {copied ? "Copied ✓" : "Copy pairing text"}
            </button>
          </div>
          <p className="muted-2" style={{ margin: 0, fontSize: 12, textAlign: "center" }}>
            The code contains a fresh sign-in for your deployment. It's shown once and saved
            nowhere — when you leave this screen it's gone, and pairing again always makes the
            previous code useless.
          </p>
          <div>
            <button
              className="btn btn-ghost"
              onClick={async () => {
                setPayload(null);
                await refresh();
              }}
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}
