// Pairing the phone (DESIGN §15h M1). The desktop shows a QR; the phone scans it —
// nobody types a pool id on glass, and the password inside the code is shown once,
// stored nowhere, and invalidated by simply pairing again.

import { useCallback, useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import { api, type PairingPayload } from "./api";
import { Button } from "./Button";

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
