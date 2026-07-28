import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import { host, type AccessState } from "./host";
import { CrewCard } from "./CrewCard";
import { EmailCard } from "./EmailCard";
import { ModelsCard } from "./ModelsCard";
import { RemovePanel } from "./RemovePanel";
import type { DeploymentStatus, Meta, ModelChoice } from "./types";

// Served from frontend/public → dist root; the same file the manifest declares as our icon.
const icon = "./crewpoppy-icon.png";

const POLL_MS = 5_000;

type Phase = "loading" | "gate" | "ready";

export function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [access, setAccess] = useState<AccessState>("pending");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [crewSize, setCrewSize] = useState(0);
  const pollRef = useRef<number | null>(null);

  /**
   * Read the real state out of the user's AWS account. This is the ONLY source of truth
   * for where the user is (AGENTS.md §5) — nothing is remembered across mounts, so
   * closing the window mid-setup and coming back lands on live progress.
   */
  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setErr(null);
      return s;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }, []);

  const connect = useCallback(async () => {
    setErr(null);
    try {
      const state = await host.ensureAccess();
      setAccess(state);
      if (state !== "granted") return;
      setMeta(await api.meta());
      await refresh();
      setPhase("ready");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [refresh]);

  // On mount: if access is already granted, go straight to live state — don't make the
  // user re-approve or re-trigger anything they already did.
  useEffect(() => {
    void (async () => {
      try {
        const conn = await host.getConnection();
        if (conn.status === "approved" || conn.status === "active") {
          await connect();
          return;
        }
      } catch {
        /* not connected yet — fall through to the gate */
      }
      setPhase("gate");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll only while AWS is actually mid-operation, and re-attach automatically on mount
  // if we return to find work still in flight.
  useEffect(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (phase !== "ready" || !status?.inProgress) return;
    pollRef.current = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [phase, status?.inProgress, refresh]);

  // Returns the promise so the Button that triggered it stays spinning until AWS has
  // accepted the request and we've read back the (now in-progress) live state.
  const deploy = async () => {
    setErr(null);
    try {
      await api.deploy();
      await refresh(); // picks up *_IN_PROGRESS, which starts the poller
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  if (phase === "loading") {
    return (
      <div className="app">
        <Header />
        <div className="card row">
          <span className="spinner" /> <span className="muted">Checking your setup…</span>
        </div>
      </div>
    );
  }

  if (phase === "gate") {
    return (
      <div className="app">
        <Header />
        <div className="card stack">
          <p style={{ margin: 0 }}>
            CrewPoppy runs your AI agents in <strong>your own AWS account</strong> — their instructions,
            their memory, their work and what they cost all stay yours, and nobody else can see them. To
            set that up, it needs your permission to create its own home there.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            It can only ever touch the things it creates itself, and you can remove all of them in one
            click. Agents never get keys to your account — they can only use the tools you give them.
          </p>
          {access === "denied" && (
            <div className="banner err">
              Access wasn't granted. You can approve CrewPoppy in AgentsPoppy and try again.
            </div>
          )}
          {err && <div className="banner err">{err}</div>}
          <div>
            <Button className="btn btn-primary" busyLabel="Waiting for approval…" onClick={connect}>
              Connect my AWS account
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const phaseKey = status?.phase ?? "none";

  return (
    <div className="app">
      <Header />

      {err && <div className="banner err" style={{ marginBottom: 14 }}>{err}</div>}

      {phaseKey === "none" && (
        <div className="card stack">
          <h2 className="section-title">Set up Mission Control</h2>
          <p style={{ margin: 0 }}>
            One click builds your crew's home base inside your own AWS account in{" "}
            <strong>{meta?.account.region}</strong>: a place for their instructions and memory, a
            workspace for their files, and the engine that runs them. It takes about a minute.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Nothing runs yet, so nothing is being billed. Creating agents is free — you pay AWS only
            when they actually work.
          </p>
          <div>
            <Button className="btn btn-primary" busyLabel="Starting…" onClick={deploy}>
              Set up CrewPoppy
            </Button>
          </div>
        </div>
      )}

      {(phaseKey === "deploying" || phaseKey === "removing") && (
        <div className="card stack">
          <div className="row">
            <span className="spinner" />
            <strong>{phaseKey === "deploying" ? "Setting up in your AWS account…" : "Removing everything…"}</strong>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            This keeps running in your AWS account even if you close this tab or switch to something
            else — come back any time and you'll see where it got to.
          </p>
        </div>
      )}

      {phaseKey === "ready" && (
        <>
          <div className="card stack">
            <div className="spread">
              <strong>Mission Control is set up</strong>
              <span className="badge ok">
                <span className="dot" /> Ready
              </span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Your crew's home base is live in {status?.region}. Everything an agent thinks, learns
              and produces stays in this account.
            </p>
            {/* The money line lives in CrewCard, which KNOWS the crew — a static banner
                here once claimed "no agents exist yet" forever, spend and all. */}
          </div>
          {/* Without this there is NO WAY to ship new engine code to an existing
              deployment: the deploy button only shows when no stack exists, so a user
              who set up once would run the original Lambda forever. That is exactly
              how two runs ended up dispatched to the empty P0 stub. */}
          {status?.updateAvailable && (
            <div className="card stack">
              <div className="spread">
                <strong>An update is ready for your AWS account</strong>
                <span className="badge warn">
                  <span className="dot" /> Update available
                </span>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                CrewPoppy's engine — the part that runs your agents inside your account — is newer
                than the one deployed. Agents can't use new abilities until you apply it, and
                scheduled runs won't pick up fixes either. It takes about a minute and nothing
                your crew has learned is lost.
              </p>
              <div>
                <Button className="btn btn-primary" busyLabel="Updating…" onClick={deploy}>
                  Apply the update
                </Button>
              </div>
            </div>
          )}
          {/* Only meaningful once the stack exists — an agent needs both a home and a brain. */}
          <CrewCard models={models} onCrewSize={setCrewSize} />
          <EmailCard />
          {/* Reference once a crew exists — collapsed, with the AWS page as a plain
              link. On first run it stays the full panel: choosing a model IS the task. */}
          <ModelsCard onModels={setModels} quiet={crewSize > 0} />
        </>
      )}

      {phaseKey === "failed" && (
        <div className="card stack">
          <div className="banner err">{status?.message}</div>
          {status?.failureReason && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              What AWS reported: <span className="mono">{status.failureReason}</span>
            </p>
          )}
          <div>
            <Button className="btn btn-primary" busyLabel="Starting…" onClick={deploy}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {status && status.phase !== "none" && (
        <RemovePanel
          disabled={status.inProgress}
          onRemove={async () => {
            await api.teardown();
            await refresh();
          }}
        />
      )}

      {/* Layer the depth: plain path above, exact technical detail one click away
          (AGENTS.md §9 "relocate technical detail, don't delete it"). */}
      <button className="btn btn-ghost btn-sm" onClick={() => setShowDetails((v) => !v)}>
        {showDetails ? "Hide technical details" : "Technical details"}
      </button>
      {showDetails && status && (
        <div className="card card-2" style={{ marginTop: 8 }}>
          <dl className="stack" style={{ margin: 0 }}>
            <Detail label="AWS account" value={meta?.account.accountId} />
            <Detail label="Region" value={status.region} />
            <Detail label="CloudFormation stack" value={status.stackName} />
            <Detail label="Stack status" value={status.stackStatus ?? "not deployed"} />
            <Detail label="DynamoDB table" value={status.tableName ?? "—"} />
            <Detail label="Agent runner" value={status.runnerFunctionName ?? "—"} />
            <Detail label="Template version" value={status.currentTemplateKey} />
            <Detail label="Deployed template" value={status.deployedTemplateKey ?? "unknown"} />
            {/* Shown ALWAYS, not only when an update is pending: the runner and the
                template version independently, and hiding one of them is how a stale
                Lambda went unnoticed for hours. */}
            <Detail label="Runner version" value={status.currentLambdaKey} />
            <Detail label="Deployed runner" value={status.deployedLambdaKey ?? "unknown"} />
          </dl>
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <>
      <div className="app-header">
        <img src={icon} alt="" />
        <h1>CrewPoppy</h1>
      </div>
      <p className="app-sub">Mission Control for your AI crew — agents that run in your own AWS account.</p>
    </>
  );
}

function Detail(props: { label: string; value?: string }) {
  return (
    <div className="spread">
      <span className="muted" style={{ fontSize: 12 }}>
        {props.label}
      </span>
      <span className="chip">{props.value ?? "—"}</span>
    </div>
  );
}
