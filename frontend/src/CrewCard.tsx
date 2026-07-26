import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import type { AgentSummary, ModelChoice, RunRecord, ToolOption, TranscriptEntry } from "./types";

/**
 * The crew: define an agent, give it a job, read its answer, see what it cost.
 *
 * "Unlimited agents" is literal (DESIGN §3) — an agent is a row, free until it runs —
 * so creating one asks for the four things that actually shape its behaviour and
 * pre-fills safe caps rather than interrogating the user about limits.
 *
 * Every run's state lives in the user's own DynamoDB, so this view polls rather than
 * remembering: close the window mid-run and the answer is waiting when you return
 * (AGENTS.md §5).
 */
const POLL_MS = 2_500;

function money(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function CrewCard(props: { models: ModelChoice[] }) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAgents((await api.listAgents()).agents);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void api.listTools().then((t) => setTools(t.tools)).catch(() => {});
  }, [refresh]);

  if (!agents) return null;

  return (
    <div className="card stack">
      <div className="spread">
        <strong>Your crew</strong>
        {agents.length > 0 && (
          <span className="badge">
            <span className="dot" /> {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {err && <div className="banner err">{err}</div>}

      {agents.length === 0 && !creating && (
        <>
          <p style={{ margin: 0 }}>
            An AI teammate that does one job well, in your own cloud. Give it a name, a job title
            and instructions — then hand it work.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Creating an agent is free. You only pay AWS when it actually runs, and every agent has
            a monthly spending limit you set.
          </p>
        </>
      )}

      {agents.map((a) => (
        <AgentRow key={a.id} agent={a} models={props.models} onChanged={refresh} />
      ))}

      {creating ? (
        <NewAgentForm
          models={props.models}
          tools={tools}
          onCancel={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      ) : (
        <div>
          <Button className="btn btn-primary" onClick={() => setCreating(true)}>
            {agents.length === 0 ? "Create your first agent" : "Add another agent"}
          </Button>
        </div>
      )}
    </div>
  );
}

function NewAgentForm(props: {
  models: ModelChoice[];
  tools: ToolOption[];
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const usable = props.models.filter((m) => m.ready);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [modelId, setModelId] = useState(usable[0]?.id ?? props.models[0]?.id ?? "");
  const [cap, setCap] = useState(10);
  // Nothing is on by default. An agent starts able only to read its task and answer —
  // every ability is something the owner deliberately grants (DESIGN §1b).
  const [chosen, setChosen] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const ready = name.trim() && role.trim() && instructions.trim() && modelId;

  return (
    <div className="card card-2" style={{ margin: 0 }}>
      <h3 className="section-title">New agent</h3>
      <div className="grid-2">
        <label className="field">
          <span>Name — what you'll call them</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Emma" />
        </label>
        <label className="field">
          <span>Job title</span>
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Research Assistant" />
        </label>
      </div>
      <label className="field">
        <span>Instructions — the brief: what they do, and how</span>
        <textarea
          className="input"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="You research topics and answer in short, plain paragraphs. Always say when you're unsure."
        />
        {/* DESIGN §4b: the commonest misconception is that instructions grant ABILITY.
            They don't — knowing how to write a reply is built in; reaching an inbox is
            a TOOL. Saying so here prevents the disappointment instead of explaining it
            after a run that quietly did nothing. */}
        <small className="muted" style={{ fontSize: 12 }}>
          Describe the job and the judgement, not the plumbing. Right now this agent can only read
          the task you type and reply in writing — it can't reach your email, files or the web.
          Those arrive as <strong>tools</strong> you switch on, one at a time.
        </small>
      </label>
      <div className="grid-2">
        <label className="field">
          <span>Which model does the thinking</span>
          <select className="select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {/* Deliberately NOT disabled. `ready` comes from the model-agreement status,
                and that field can lag behind reality — a user who has completed the form
                would otherwise find the model they want permanently unselectable, with no
                way out. Selecting an unready model is free: AWS rejects it before any
                inference, and the runner turns that rejection into a plain sentence
                telling them exactly what's missing. Never build a dead end out of a
                signal you don't fully trust. */}
            {props.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.cost}){m.ready ? "" : " — may still be switching on"}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Spending limit per month</span>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            value={cap}
            onChange={(e) => setCap(Number(e.target.value))}
          />
          <small className="muted" style={{ fontSize: 12 }}>
            They stop when they reach it. You can change it any time.
          </small>
        </label>
      </div>
      {props.tools.length > 0 && (
        <label className="field">
          <span>What this agent is allowed to do</span>
          <div className="stack" style={{ marginTop: 4 }}>
            {props.tools.map((t) => (
              <label key={t.name} className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={chosen.includes(t.name)}
                  onChange={(e) =>
                    setChosen((c) => (e.target.checked ? [...c, t.name] : c.filter((x) => x !== t.name)))
                  }
                  style={{ marginTop: 3 }}
                />
                <span style={{ flex: 1 }}>
                  <strong style={{ fontSize: 13 }}>{t.label}</strong>
                  <span className="muted" style={{ display: "block", fontSize: 12 }}>
                    {t.what}
                  </span>
                  {t.risk && (
                    <span className="muted-2" style={{ display: "block", fontSize: 12 }}>
                      ⚠ {t.risk}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          <small className="muted" style={{ fontSize: 12 }}>
            Everything is off to begin with. Give an agent only what its job needs — don't give it
            anything you wouldn't want a stranger triggering.
          </small>
        </label>
      )}
      {err && <div className="banner err">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={props.onCancel}>
          Cancel
        </button>
        <Button
          className="btn btn-primary"
          disabled={!ready}
          busyLabel="Creating…"
          onClick={async () => {
            setErr(null);
            try {
              await api.saveAgent({
                name, role, instructions, modelId, tools: chosen, caps: { monthlySpendCapUsd: cap },
              });
              await props.onCreated();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Create agent
        </Button>
      </div>
    </div>
  );
}

/**
 * Deleting one agent (AGENTS.md §4, the scoped destructive control).
 *
 * This is smaller than removing CrewPoppy, but it is the same KIND of act: what an agent
 * has learned and every file it made go with it, and nothing brings them back. So it gets
 * the same ceremony at a smaller scale — a second step, the blast radius named plainly,
 * and type-the-name to arm the button. Typing the NAME rather than a fixed word does a
 * second job: on a card among several, it's the answer to "which one am I deleting?".
 *
 * Cancel holds focus, and the danger button is never the easy default.
 */
function DeleteAgent(props: { agent: AgentSummary; onDeleted: () => Promise<void> }) {
  const { agent } = props;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const matches = typed.trim() === agent.name;

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setTyped("");
    setErr(null);
  };

  return (
    <>
      <button
        className="btn btn-ghost"
        onClick={() => setOpen(true)}
        title={`Delete ${agent.name}`}
        aria-label={`Delete ${agent.name}`}
      >
        Delete…
      </button>

      {open && (
        <div className="scrim" role="dialog" aria-modal="true" aria-labelledby={`del-${agent.id}`}>
          <div className="modal stack">
            <h3 id={`del-${agent.id}`} style={{ margin: 0 }}>
              Delete {agent.name}?
            </h3>
            <p style={{ margin: 0 }}>This permanently deletes:</p>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>everything {agent.name} has remembered</li>
              <li>every file it saved in its workspace</li>
              <li>the record of every run it did, and what each one cost</li>
            </ul>
            <p style={{ margin: 0 }}>
              <strong>This can't be undone.</strong> You can make a new agent with the same name, but
              it starts knowing nothing. The rest of your crew isn't touched.
            </p>
            <label className="field" style={{ margin: 0 }}>
              <span>
                To switch on the button below, type <strong>{agent.name}</strong> here:
              </span>
              <input
                className="input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={agent.name}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label={`Type ${agent.name} to confirm`}
              />
              {typed.length > 0 && !matches && (
                <small className="muted" style={{ fontSize: 12 }}>
                  Doesn't match yet — type the name exactly as it's written above.
                </small>
              )}
            </label>
            {err && <div className="banner err">{err}</div>}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" ref={cancelRef} onClick={close}>
                Cancel
              </button>
              <Button
                className="btn btn-danger"
                disabled={!matches}
                busyLabel="Deleting…"
                title={matches ? undefined : `Type ${agent.name} above to switch this on`}
                onClick={async () => {
                  setErr(null);
                  try {
                    await api.deleteAgent(agent.id);
                    // Closing before the refresh would flash the card back for a beat.
                    await props.onDeleted();
                    close();
                  } catch (e) {
                    // A live run is refused here, in the plain sentence the backend wrote.
                    setErr((e as Error).message);
                  }
                }}
              >
                Delete {agent.name} permanently
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AgentRow(props: { agent: AgentSummary; models: ModelChoice[]; onChanged: () => Promise<void> }) {
  const { agent } = props;
  // Which brain this agent thinks with. Chosen once at creation and then invisible —
  // nobody remembers weeks later, and it drives both quality and cost, so it belongs on
  // the card. Fall back to the raw id if the catalogue has moved on.
  const model = props.models.find((m) => m.id === agent.modelId);
  const [task, setTask] = useState("");
  const [answer, setAnswer] = useState("");
  const [run, setRun] = useState<RunRecord | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const poll = useCallback(
    async (runId: string) => {
      try {
        const r = await api.getRun(agent.id, runId);
        setRun(r.run);
        setTranscript(r.transcript);
        if (r.run.status !== "running") void props.onChanged(); // spend may have moved
      } catch {
        /* transient — the poller tries again */
      }
    },
    [agent.id, props],
  );

  // Poll only while a run is actually in flight.
  useEffect(() => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
    if (!run || (run.status !== "running" && run.status !== "waiting")) return;
    const id = run.runId;
    timer.current = window.setInterval(() => void poll(id), POLL_MS);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [run, poll]);

  const spent = agent.monthSpendUsd ?? 0;
  const atCap = spent >= agent.caps.monthlySpendCapUsd;

  return (
    <div className="card card-2" style={{ margin: 0 }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="row" style={{ gap: 8 }}>
            <strong>{agent.name}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {agent.role}
            </span>
          </div>
          <p className="muted-2" style={{ margin: "4px 0 0", fontSize: 12 }}>
            {agent.tools?.length ? `Can: ${agent.tools.length} tool${agent.tools.length === 1 ? "" : "s"} · ` : ""}
            Thinks with <strong>{model?.label ?? agent.modelId}</strong>
            {model ? ` (${model.cost})` : ""} · this month: {money(spent)} of $
            {agent.caps.monthlySpendCapUsd.toFixed(2)} limit
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className={`badge ${atCap ? "warn" : "ok"}`}>
            <span className="dot" /> {atCap ? "At limit" : "Ready"}
          </span>
          <DeleteAgent agent={agent} onDeleted={props.onChanged} />
        </div>
      </div>

      <label className="field" style={{ marginTop: 10, marginBottom: 0 }}>
        <span>Give {agent.name} something to do</span>
        <textarea
          className="input"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Summarise the main arguments for and against four-day work weeks."
        />
      </label>
      {err && <div className="banner err" style={{ marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <Button
          className="btn btn-primary"
          disabled={!task.trim() || run?.status === "running"}
          busyLabel="Starting…"
          onClick={async () => {
            setErr(null);
            setTranscript([]);
            try {
              const r = await api.startRun(agent.id, task);
              setRun(r);
              void poll(r.runId);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Run
        </Button>
        {run?.status === "running" && (
          <>
            <span className="row muted" style={{ gap: 6 }}>
              <span className="spinner" /> Working… this keeps going if you leave.
            </span>
            {/* The kill switch (DESIGN §7). Always reachable while a run is live. */}
            <Button
              className="btn btn-danger"
              busyLabel="Stopping…"
              onClick={async () => {
                try {
                  setRun(await api.stopRun(agent.id, run.runId));
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Stop
            </Button>
          </>
        )}
      </div>

      {run?.status === "waiting" && (
        <div className="card stack" style={{ marginTop: 10, borderColor: "var(--poppy-warn)" }}>
          <div className="spread">
            <strong>{agent.name} is waiting for you</strong>
            <span className="badge warn">
              <span className="dot" /> Needs your answer
            </span>
          </div>
          <p style={{ margin: 0 }}>{run.message}</p>
          {/* The draft is shown verbatim: approving something you haven't read is not
              approval. It appears as the last thing the agent said. */}
          {transcript.filter((t) => t.role === "assistant").slice(-1).map((t) => (
            <div key={t.seq} className="card" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {t.text}
            </div>
          ))}
          <label className="field" style={{ margin: 0 }}>
            <span>Your answer</span>
            <textarea
              className="input"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Yes, send it — but change the greeting to 'Hi Sam'."
            />
          </label>
          <div className="row">
            <Button
              className="btn btn-primary"
              busyLabel="Sending…"
              onClick={async () => {
                setErr(null);
                try {
                  setRun(await api.answerRun(agent.id, run.runId, answer.trim() || "Yes, go ahead."));
                  setAnswer("");
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              {answer.trim() ? "Send answer" : "Approve"}
            </Button>
            <Button
              className="btn"
              busyLabel="Sending…"
              onClick={async () => {
                setErr(null);
                try {
                  setRun(await api.answerRun(agent.id, run.runId, "No — do not do that. Stop and explain why you asked."));
                  setAnswer("");
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Deny
            </Button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            The run picks up exactly where it paused — nothing it already did is repeated.
          </p>
        </div>
      )}

      {run && run.status !== "running" && run.status !== "waiting" && (
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="spread">
            <span className={`badge ${run.status === "succeeded" ? "ok" : "warn"}`}>
              <span className="dot" /> {run.status === "succeeded" ? "Answered" : run.status}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {run.cost.usage.inputTokens.toLocaleString()} in / {run.cost.usage.outputTokens.toLocaleString()} out
              {" · "}
              {run.cost.usd === undefined ? (
                <span title="AWS publishes no per-token price for this model yet. Your spending limit still applies — CrewPoppy counts it using a deliberately high estimate, so the limit stops you early rather than late.">
                  cost not published — limit still enforced
                </span>
              ) : (
                <strong>
                  ≈ {money(run.cost.usd)}
                  {run.cost.approx ? " (approx)" : ""}
                </strong>
              )}
            </span>
          </div>
          {run.message && <div className="banner info">{run.message}</div>}
          {transcript
            .filter((t) => t.role === "assistant" || t.role === "tool")
            .map((t) =>
              t.role === "tool" ? (
                // Every tool call is visible — nothing an agent does is hidden (DESIGN §9).
                <p key={t.seq} className="muted-2 mono" style={{ margin: 0, fontSize: 12 }}>
                  ⚙ {t.text}
                </p>
              ) : (
                <p key={t.seq} style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                  {t.text}
                </p>
              ),
            )}
        </div>
      )}
    </div>
  );
}
