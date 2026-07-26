import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button } from "./Button";
import type {
  AgentSummary, ModelChoice, OwnerEmail, PendingSend, RunRecord, ToolCatalogue, TranscriptEntry,
} from "./types";

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
  const [catalogue, setCatalogue] = useState<ToolCatalogue | null>(null);
  const [owner, setOwner] = useState<OwnerEmail>({});
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

  const refreshOwner = useCallback(async () => {
    try {
      setOwner(await api.ownerEmail());
    } catch {
      /* the email card shows its own state; the crew list still works */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshOwner();
    void api.listTools().then(setCatalogue).catch(() => {});
  }, [refresh, refreshOwner]);

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
        <AgentRow
          key={a.id}
          agent={a}
          models={props.models}
          catalogue={catalogue}
          owner={owner}
          onChanged={refresh}
        />
      ))}

      {creating ? (
        <AgentForm
          models={props.models}
          catalogue={catalogue}
          owner={owner}
          onCancel={() => setCreating(false)}
          onSaved={async () => {
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

/**
 * Create or edit one agent — and, at the bottom, the SET of capabilities the owner is
 * approving (founder decision, 2026-07-26).
 *
 * The founder's framing: "the user needs to approve all capabilities allowed to an
 * agent." So this doesn't scatter switches through the form and hope they're read. It
 * groups them the way an owner actually asks — can it email? only me? other people? —
 * and ends with a plain sentence of everything the agent will be able to do, right above
 * the button that grants it. Nothing is on by default, and nothing is granted quietly.
 */
function AgentForm(props: {
  models: ModelChoice[];
  catalogue: ToolCatalogue | null;
  owner: OwnerEmail;
  /** Absent when creating. */
  agent?: AgentSummary;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = !!props.agent;
  // Models the ENGINE can drive. A model we can't talk to must never be the silent
  // default: that's how an agent ended up on Qwen and failed with "the provided model
  // identifier is invalid" the first time it was asked to do real work.
  const drivable = props.models.filter((m) => m.supported !== false);
  const usable = drivable.filter((m) => m.ready);
  const [name, setName] = useState(props.agent?.name ?? "");
  const [role, setRole] = useState(props.agent?.role ?? "");
  const [instructions, setInstructions] = useState(props.agent?.instructions ?? "");
  const [modelId, setModelId] = useState(
    props.agent?.modelId ?? usable[0]?.id ?? drivable[0]?.id ?? "",
  );
  const [cap, setCap] = useState(props.agent?.caps.monthlySpendCapUsd ?? 10);
  // Nothing is on by default. An agent starts able only to read its task and answer —
  // every ability is something the owner deliberately grants (DESIGN §1b).
  const [chosen, setChosen] = useState<string[]>(props.agent?.tools ?? []);
  const [emailFrom, setEmailFrom] = useState(props.agent?.emailFrom ?? "");
  const [senderState, setSenderState] = useState<"unknown" | "checking" | "ok" | "bad">("unknown");
  const [err, setErr] = useState<string | null>(null);
  const ready = name.trim() && role.trim() && instructions.trim() && modelId;

  const notes = new Map((props.catalogue?.tools ?? []).map((t) => [t.name, t]));
  const wantsEmail = (props.catalogue?.needsEmail ?? []).some((t) => chosen.includes(t));
  const granted = chosen.map((t) => notes.get(t)?.label ?? t);

  // An address of its own must be one AWS will really send from. Checked as it's typed,
  // so the answer arrives before the save rather than as a bounce days later.
  useEffect(() => {
    const value = emailFrom.trim();
    if (!value) return setSenderState("unknown");
    setSenderState("checking");
    const t = window.setTimeout(() => {
      void api
        .verifySender(value)
        .then((r) => setSenderState(r.verified ? "ok" : "bad"))
        .catch(() => setSenderState("unknown"));
    }, 500);
    return () => window.clearTimeout(t);
  }, [emailFrom]);

  return (
    <div className="card card-2" style={{ margin: 0 }}>
      <h3 className="section-title">{editing ? `Edit ${props.agent!.name}` : "New agent"}</h3>
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
          Describe the job and the judgement, not the plumbing. What this agent can actually
          reach is decided below — instructions never grant an ability.
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
              // Unsupported models stay VISIBLE but unpickable: hiding them would make
              // the catalogue silently disagree with the models card. Disabling here is
              // safe in a way disabling on `ready` was not — this signal is ours, and we
              // know for certain whether the runner can speak to a model.
              <option key={m.id} value={m.id} disabled={m.supported === false}>
                {m.label} ({m.cost})
                {m.supported === false
                  ? " — CrewPoppy can't drive this one yet"
                  : m.ready
                    ? ""
                    : " — may still be switching on"}
              </option>
            ))}
          </select>
          {props.models.some((m) => m.supported === false) && (
            <small className="muted" style={{ fontSize: 12 }}>
              Some models are greyed out because CrewPoppy's engine doesn't speak their
              format yet. That's our gap, not your account's.
            </small>
          )}
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

      {props.catalogue && (
        <div className="field">
          <span>What {name.trim() || "this agent"} is allowed to do</span>
          <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>
            Everything starts off. Give it only what its job needs — don't give it anything you
            wouldn't want a stranger triggering.
          </p>
          {props.catalogue.groups.map((g) => (
            <div key={g.key} className="card" style={{ margin: "0 0 8px", padding: 10 }}>
              <div className="row" style={{ gap: 8, marginBottom: 2 }}>
                <strong style={{ fontSize: 13 }}>{g.label}</strong>
                <span className="muted-2" style={{ fontSize: 12 }}>{g.what}</span>
              </div>
              {g.tools.map((t) => {
                const note = notes.get(t);
                if (!note) return null;
                return (
                  <label key={t} className="row" style={{ alignItems: "flex-start", gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(t)}
                      onChange={(e) =>
                        setChosen((c) => (e.target.checked ? [...c, t] : c.filter((x) => x !== t)))
                      }
                      style={{ marginTop: 3 }}
                    />
                    <span style={{ flex: 1 }}>
                      <strong style={{ fontSize: 13 }}>{note.label}</strong>
                      <span className="muted" style={{ display: "block", fontSize: 12 }}>{note.what}</span>
                      {note.risk && (
                        <span className="muted-2" style={{ display: "block", fontSize: 12 }}>
                          ⚠ {note.risk}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}

          {/* Only asked once email is actually wanted — an address field on an agent that
              never emails is a question with no purpose. */}
          {wantsEmail && (
            <div className="card" style={{ margin: "0 0 8px", padding: 10 }}>
              <label className="field" style={{ margin: 0 }}>
                <span>Does {name.trim() || "this agent"} have an email address of its own?</span>
                <input
                  className="input"
                  value={emailFrom}
                  onChange={(e) => setEmailFrom(e.target.value)}
                  placeholder={props.owner.email ? `Leave empty to send from ${props.owner.email}` : "emma@yourdomain.com"}
                  autoComplete="off"
                  spellCheck={false}
                />
                <small className="muted" style={{ fontSize: 12 }}>
                  {senderState === "checking" && "Checking your AWS account…"}
                  {senderState === "ok" && "✓ Your AWS account can send from this address."}
                  {senderState === "bad" &&
                    "Your AWS account hasn't verified this address, so mail from it would bounce. Verify it (or its domain) in SES first — MailPoppy addresses already are."}
                  {senderState === "unknown" &&
                    "Optional. Leave it empty and it sends from your own address instead."}
                </small>
              </label>
            </div>
          )}

          {!props.owner.email && wantsEmail && (
            <div className="banner warn">
              No address is set for CrewPoppy yet, so the email abilities won't do anything. Set one
              under "Email" above the crew list first — you can still save this agent now.
            </div>
          )}

          {/* The grant, in one sentence, immediately above the button that grants it. */}
          <div className="card" style={{ margin: 0, padding: 10 }}>
            <strong style={{ fontSize: 13 }}>
              {editing ? `${props.agent!.name} will be able to:` : `${name.trim() || "This agent"} will be able to:`}
            </strong>
            {granted.length === 0 ? (
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                Nothing beyond reading the task you type and replying in writing. That's a safe
                place to start.
              </p>
            ) : (
              <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {granted.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {err && <div className="banner err">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={props.onCancel}>
          Cancel
        </button>
        <Button
          className="btn btn-primary"
          disabled={!ready}
          busyLabel={editing ? "Saving…" : "Creating…"}
          onClick={async () => {
            setErr(null);
            try {
              await api.saveAgent({
                ...(props.agent ? { id: props.agent.id } : {}),
                name,
                role,
                instructions,
                modelId,
                tools: chosen,
                emailFrom: emailFrom.trim(),
                caps: { ...(props.agent?.caps ?? {}), monthlySpendCapUsd: cap },
              });
              await props.onSaved();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          {editing ? "Save changes" : "Create agent"}
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

function AgentRow(props: {
  agent: AgentSummary;
  models: ModelChoice[];
  catalogue: ToolCatalogue | null;
  owner: OwnerEmail;
  onChanged: () => Promise<void>;
}) {
  const { agent } = props;
  const [editing, setEditing] = useState(false);
  // Which brain this agent thinks with. Chosen once at creation and then invisible —
  // nobody remembers weeks later, and it drives both quality and cost, so it belongs on
  // the card. Fall back to the raw id if the catalogue has moved on.
  const model = props.models.find((m) => m.id === agent.modelId);
  const [task, setTask] = useState("");
  const [answer, setAnswer] = useState("");
  const [run, setRun] = useState<RunRecord | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  /** The exact message waiting on approval, read from the run's checkpoint. */
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const poll = useCallback(
    async (runId: string) => {
      try {
        const r = await api.getRun(agent.id, runId);
        setRun(r.run);
        setTranscript(r.transcript);
        setPending(r.pending ?? null);
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
          {/* Capabilities can be taken back as well as given — a grant you can't revoke
              isn't really a grant. */}
          <button className="btn btn-ghost" onClick={() => setEditing(true)}>
            Edit…
          </button>
          <DeleteAgent agent={agent} onDeleted={props.onChanged} />
        </div>
      </div>

      {editing && (
        <div style={{ marginTop: 10 }}>
          <AgentForm
            models={props.models}
            catalogue={props.catalogue}
            owner={props.owner}
            agent={agent}
            onCancel={() => setEditing(false)}
            onSaved={async () => {
              setEditing(false);
              await props.onChanged();
            }}
          />
        </div>
      )}

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

          {pending ? (
            /* An email it wants to send. Shown as the message itself — address, subject,
               words — because approving a summary is not approving an email. What is on
               this screen is what gets sent: the runner sends the stored copy, so the
               agent cannot change the address or the wording after you've said yes. */
            <div className="card stack" style={{ margin: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="muted" style={{ fontSize: 12, minWidth: 56 }}>To</span>
                <strong className="mono" style={{ fontSize: 13 }}>{pending.to}</strong>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="muted" style={{ fontSize: 12, minWidth: 56 }}>Subject</span>
                <strong style={{ fontSize: 13 }}>{pending.subject}</strong>
              </div>
              <div style={{ whiteSpace: "pre-wrap", borderTop: "1px solid var(--poppy-border)", paddingTop: 8 }}>
                {pending.body}
              </div>
            </div>
          ) : (
            /* A plain question. The draft is shown verbatim: approving something you
               haven't read is not approval. */
            transcript.filter((t) => t.role === "assistant").slice(-1).map((t) => (
              <div key={t.seq} className="card" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {t.text}
              </div>
            ))
          )}

          <label className="field" style={{ margin: 0 }}>
            <span>{pending ? "Or reply with changes instead" : "Your answer"}</span>
            <textarea
              className="input"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={
                pending
                  ? "Make it shorter, and use 'Hi Sam' as the greeting."
                  : "Yes, send it — but change the greeting to 'Hi Sam'."
              }
            />
            {pending && (
              <small className="muted" style={{ fontSize: 12 }}>
                Anything you type here is a change, not a yes — {agent.name} rewrites the message
                and asks you again. Only <strong>Send it</strong> sends the email above.
              </small>
            )}
          </label>
          <div className="row">
            {/* Approve is the ONLY thing that sends. It carries an explicit flag; the
                words in the box are never read as consent (DESIGN §4c). */}
            <Button
              className="btn btn-primary"
              disabled={!!pending && !!answer.trim()}
              title={pending && answer.trim() ? "Clear your reply to send the message as written" : undefined}
              busyLabel="Sending…"
              onClick={async () => {
                setErr(null);
                try {
                  setRun(
                    await api.answerRun(
                      agent.id,
                      run.runId,
                      pending ? "Approved — send it exactly as written." : answer.trim() || "Yes, go ahead.",
                      true,
                    ),
                  );
                  setAnswer("");
                  setPending(null);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              {pending ? "Send it" : answer.trim() ? "Send answer" : "Approve"}
            </Button>
            {pending && answer.trim() && (
              <Button
                className="btn"
                busyLabel="Sending…"
                onClick={async () => {
                  setErr(null);
                  try {
                    setRun(await api.answerRun(agent.id, run.runId, answer.trim()));
                    setAnswer("");
                    setPending(null);
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                Send my changes back
              </Button>
            )}
            <Button
              className="btn"
              busyLabel="Sending…"
              onClick={async () => {
                setErr(null);
                try {
                  setRun(
                    await api.answerRun(
                      agent.id,
                      run.runId,
                      pending
                        ? "No — do not send that email. Stop and explain why you wanted to."
                        : "No — do not do that. Stop and explain why you asked.",
                    ),
                  );
                  setAnswer("");
                  setPending(null);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              {pending ? "Don't send" : "Deny"}
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
