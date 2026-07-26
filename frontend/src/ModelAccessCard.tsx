import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { host } from "./host";
import type { ModelAccess } from "./types";

/**
 * The one-time "turn on AI models" step (DESIGN §2c, §6).
 *
 * Anthropic requires every AWS account to submit a short use-case form before Claude can
 * be invoked. We cannot submit it for the owner: the action is account-level, cannot be
 * IAM-scoped, and would rate RED — and it's a declaration about their business that only
 * they can honestly make. So we explain it plainly, open the right page, and then get out
 * of the way.
 *
 * Background + resume (AGENTS.md §5): the card polls, so when the owner finishes in the
 * browser it disappears on its own. No "I've done it" button to press, no dead spinner.
 */
const POLL_MS = 6_000;

export function ModelAccessCard(props: { onReady?: () => void }) {
  const [access, setAccess] = useState<ModelAccess | null>(null);
  const timer = useRef<number | null>(null);
  const onReady = props.onReady;

  const check = useCallback(async () => {
    try {
      const a = await api.modelAccess();
      setAccess(a);
      if (a.ready) onReady?.();
      return a;
    } catch {
      // A backend hiccup must not replace the instructions with an error — the user's
      // next action is the same either way.
      return null;
    }
  }, [onReady]);

  useEffect(() => {
    void check();
  }, [check]);

  // Poll only while we're actually waiting for the owner to finish.
  useEffect(() => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (!access || access.ready) return;
    timer.current = window.setInterval(() => void check(), POLL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [access, check]);

  if (!access) return null;

  if (access.ready) {
    return (
      <div className="card stack">
        <div className="spread">
          <strong>AI models are on</strong>
          <span className="badge ok">
            <span className="dot" /> Ready
          </span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Your account can run Claude. Agents bill to your own AWS, and every run shows what it cost.
        </p>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="spread">
        <strong>One more step before your crew can think</strong>
        <span className="badge warn">
          <span className="dot" /> Action needed
        </span>
      </div>

      <p style={{ margin: 0 }}>
        Claude is made by Anthropic. Before your AWS account can use it, Anthropic asks a few
        questions about how you plan to use it. It's <strong>free</strong>, takes about a minute,
        and you only do it <strong>once for the whole account</strong>.
      </p>

      <ol className="muted" style={{ margin: 0, paddingLeft: 18 }}>
        <li>Open the AWS page below — it opens in your normal browser.</li>
        <li>Choose any Claude model.</li>
        <li>Fill in the short form that appears, and submit it.</li>
      </ol>

      <div className="row">
        <Button
          className="btn btn-primary"
          busyLabel="Opening…"
          onClick={async () => {
            if (access.consoleUrl) await host.openExternal(access.consoleUrl);
          }}
        >
          Open the AWS page
        </Button>
        <Button className="btn" busyLabel="Checking…" onClick={async () => void (await check())}>
          Check now
        </Button>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Your answers go to AWS and Anthropic — not to us. CrewPoppy checks every few seconds, so
        when you're done this step disappears on its own.
      </p>

      {access.unknown && (
        <div className="banner info">
          We couldn't read your account's model status just now, so these instructions may not be
          needed. If Claude already works for you, you can ignore this.
        </div>
      )}
    </div>
  );
}
