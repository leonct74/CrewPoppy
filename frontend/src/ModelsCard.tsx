import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { host } from "./host";
import type { ModelCatalogue } from "./types";

/**
 * The models a crew can think with, each answered against THIS account.
 *
 * Two things a user needs at this moment and can't get from AWS: what each model is
 * actually good at, and whether it's usable right now. Anthropic asks every account for
 * a one-time form before Claude runs; every other provider here is ready immediately.
 * Rather than blocking on that form, we show it as a per-model status so the choice is
 * theirs — take the fast lane now, or spend a minute for the better agent model.
 *
 * We never submit that form ourselves: it's account-level, can't be IAM-scoped, would
 * rate RED, and it's a declaration about their business only they can honestly make.
 *
 * Background + resume (AGENTS.md §5): the list polls while anything is still pending, so
 * finishing the form in a browser tab updates this on its own.
 */
const POLL_MS = 8_000;

export function ModelsCard({ onModels }: { onModels?: (m: ModelCatalogue["models"]) => void } = {}) {
  const [data, setData] = useState<ModelCatalogue | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.models();
      setData(d);
      onModels?.(d.models);
      return d;
    } catch {
      return null;
    }
  }, [onModels]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = !!data?.models.some((m) => !m.ready && m.formLikely);

  useEffect(() => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (!pending) return;
    timer.current = window.setInterval(() => void load(), POLL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [pending, load]);

  if (!data) return null;

  const ready = data.models.filter((m) => m.ready);
  const needsSetup = data.models.filter((m) => !m.ready);

  return (
    <div className="card stack">
      <div className="spread">
        <strong>Models your crew can think with</strong>
        <span className={`badge ${ready.length ? "ok" : "warn"}`}>
          <span className="dot" /> {ready.length} ready now
        </span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Every model here runs inside your own AWS and bills to your own account. You'll pick one
        for each agent — a cheap one for simple jobs, a stronger one where it matters.
      </p>

      {data.models.map((m) => (
        <div key={m.id} className="card card-2" style={{ margin: 0 }}>
          <div className="spread" style={{ alignItems: "flex-start" }}>
            <div>
              <div className="row" style={{ gap: 8 }}>
                <strong>{m.label}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {m.provider}
                </span>
                <span className="chip" title="Relative running cost compared with the others here">
                  {m.cost}
                </span>
              </div>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 13, maxWidth: "58ch" }}>
                {m.goodAt}
              </p>
              <p className="muted-2" style={{ margin: "4px 0 0", fontSize: 12 }}>
                {m.vision ? "Reads images · " : ""}
                {m.toolUse ? "Can use tools" : "Text only"}
              </p>
            </div>
            {m.unknown ? (
              <span className="badge">
                <span className="dot" /> Unknown
              </span>
            ) : m.ready ? (
              <span className="badge ok" title={m.proven ? "An agent has already run on this model here" : undefined}>
                <span className="dot" /> {m.proven ? "Working" : "Ready"}
              </span>
            ) : (
              // A STATE, not a demand. We can't tell "form not submitted" from "form
              // submitted, still propagating" — the API that would say is account-level
              // and unscopable — and "Needs setup" wrongly blames a user who has already
              // done it. "Not ready yet" is true in both cases.
              <span className="badge warn">
                <span className="dot" /> Not ready yet
              </span>
            )}
          </div>
        </div>
      ))}

      {needsSetup.length > 0 && (
        <>
          <p style={{ margin: 0 }}>
            <strong>{needsSetup.map((m) => m.label).join(" and ")}</strong>{" "}
            {needsSetup.length === 1 ? "isn't" : "aren't"} available on your account yet. Anthropic
            asks a few questions about how you plan to use their models — it's <strong>free</strong>,
            takes about a minute, and you only do it <strong>once for the whole account</strong>.
            Everything else above works right now without it.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            <strong>Already filled it in?</strong> Then there's nothing left to do. The first time
            you use a model, AWS sets up a subscription for your account and emails you a
            confirmation from AWS Marketplace — it's free, and once that email arrives the model
            works. This list updates itself too.
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
                if (data.consoleUrl) await host.openExternal(data.consoleUrl);
              }}
            >
              Open the AWS page
            </Button>
          </div>
          {/* Set the expectation BEFORE the user wonders, rather than answering "not yet"
              after they press something. Measured: the form registers immediately, but the
              models can lag behind it. */}
          <div className="banner info">
            <strong>After you submit the form, AWS takes a little while to switch these on.</strong>{" "}
            You don't need to do anything else — this page checks on its own and will update when
            they're ready. You can close it and come back.
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Your answers go to AWS and Anthropic — not to us.
          </p>
        </>
      )}
    </div>
  );
}
