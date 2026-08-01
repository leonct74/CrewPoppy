import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar, AvatarPicker } from "./avatars";
import { buildHelperPrompt } from "./helper-prompt";
import { Button } from "./Button";
import { PhonePane } from "./PhonePane";
import { host } from "./host";
import { describeSchedule } from "./schedule";
import type {
  AgentSchedule, AgentSummary, ModelChoice, OwnerEmail, PendingSend, RunRecord, SchedulePreview,
  TickerHealth, ToolCatalogue, TranscriptEntry, WorkspaceFile,
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

/**
 * Every zone the browser knows, with the agent's own kept in the list even if this build
 * of the runtime doesn't enumerate it — a saved schedule must never lose its clock just
 * because the picker couldn't offer it.
 */
function timezones(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf?.("timeZone");
  const list = supported?.length ? supported : ["UTC", "Europe/London", "Europe/Amsterdam", "America/New_York"];
  return list.includes(current) ? list : [current, ...list];
}

/**
 * The crew-level money line. Deliberately NOT the AWS Price List API: pricing:GetProducts
 * cannot be resource-scoped, and a wildcard read would cost the manifest's "no findings"
 * verdict — for a number our own counters already hold (DESIGN §2d, §7b). The honest
 * caveat is shown, not hidden in a tooltip: for models without a published rate (all
 * Claude, today) we count HIGH on purpose, so limits stop early rather than late.
 */
function MoneyStrip(props: { agents: AgentSummary[] }) {
  const { agents } = props;
  if (agents.length === 0) {
    return (
      <div className="banner info">
        <strong>$0.00 — nothing is being billed.</strong> Creating agents is free; you pay AWS
        only when one actually works, and every agent has a spending limit you set.
      </div>
    );
  }
  const spent = agents.reduce((s, a) => s + (a.monthSpendUsd ?? 0), 0);
  const cap = agents.reduce((s, a) => s + a.caps.monthlySpendCapUsd, 0);
  return (
    <div className="banner info">
      <div className="spread">
        <span>
          <strong>This month: ≈ {money(spent)}</strong> across {agents.length} agent
          {agents.length === 1 ? "" : "s"}
        </span>
        <span className="muted">combined limits {money(cap)} — each agent stops at its own</span>
      </div>
      <p className="muted-2" style={{ margin: "4px 0 0", fontSize: 12 }}>
        Counted by CrewPoppy from the tokens your agents actually used. Models without a
        published price are counted high on purpose, so a limit stops you early, never late.
        Your AWS bill is the final word.
      </p>
    </div>
  );
}

function money(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * The three views (founder, 2026-07-29). A column of full chat cards was fine for two
 * agents and unbearable at ten — each chat pushed the next agent off screen. Now:
 *   crew — the whole team at a glance, one compact tile per agent, a grid that grows
 *          in rows instead of pushing everything down;
 *   create — the granting ceremony gets the page to itself;
 *   chat — one agent, full width: the conversation, files, edit, delete.
 */
type CrewView = { kind: "crew" } | { kind: "create" } | { kind: "chat"; id: string } | { kind: "phone" };

export function CrewCard(props: {
  models: ModelChoice[];
  /** Lets the page demote reference panels once a crew actually exists. */
  onCrewSize?: (n: number) => void;
}) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [catalogue, setCatalogue] = useState<ToolCatalogue | null>(null);
  const [owner, setOwner] = useState<OwnerEmail>({});
  const [ticker, setTicker] = useState<TickerHealth | null>(null);
  const [view, setView] = useState<CrewView>({ kind: "crew" });
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

  const { onCrewSize } = props;
  useEffect(() => {
    if (agents) onCrewSize?.(agents.length);
  }, [agents, onCrewSize]);

  // Only asked when it can matter — an install with no schedules has no ticker to judge.
  const anyScheduled = (agents ?? []).some((a) => a.schedule?.enabled);
  useEffect(() => {
    if (!anyScheduled) return;
    const read = () => void api.ticker().then(setTicker).catch(() => {});
    read();
    const t = window.setInterval(read, 60_000);
    return () => window.clearInterval(t);
  }, [anyScheduled]);

  if (!agents) return null;

  // Deep views resolve their agent from the live list, so a refresh (or a delete from
  // another path) can never leave the page talking to a ghost.
  const chatAgent = view.kind === "chat" ? agents.find((a) => a.id === view.id) : undefined;
  if (view.kind === "chat" && !chatAgent) {
    setView({ kind: "crew" });
    return null;
  }

  if (view.kind === "chat" && chatAgent) {
    return (
      <div className="card stack">
        {err && <div className="banner err">{err}</div>}
        <AgentRow
          agent={chatAgent}
          models={props.models}
          catalogue={catalogue}
          owner={owner}
          onChanged={refresh}
          onBack={() => setView({ kind: "crew" })}
        />
      </div>
    );
  }

  if (view.kind === "phone") {
    return <PhonePane onBack={() => setView({ kind: "crew" })} />;
  }

  if (view.kind === "create") {
    return (
      <div className="card stack">
        <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setView({ kind: "crew" })}>
          ← Your crew
        </button>
        <AgentForm
          models={props.models}
          catalogue={catalogue}
          owner={owner}
          onCancel={() => setView({ kind: "crew" })}
          onSaved={async () => {
            await refresh();
            setView({ kind: "crew" });
          }}
        />
      </div>
    );
  }

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

      {/* Show the money (AGENTS.md §9) — the rule CrewPoppy exists to exemplify. One
          line, always current, computed from the same spend counters the caps enforce,
          so the number the user sees and the number that stops a run can never differ. */}
      <MoneyStrip agents={agents} />

      {/* Says which half is broken. "AWS never woke us" and "it woke us and nothing was
          due" need completely different fixes and used to look identical — as a blank
          screen and a schedule that silently didn't happen. */}
      {anyScheduled && ticker && !ticker.healthy && (
        <div className="banner err">
          {ticker.everRan ? (
            <>
              <strong>Scheduled runs have stopped.</strong> AWS last woke CrewPoppy at{" "}
              {new Date(ticker.at!).toLocaleString()}. If there's an update waiting above, apply
              it — otherwise check that CrewPoppyTick is enabled in your EventBridge rules.
            </>
          ) : (
            <>
              <strong>Scheduled runs aren't working yet.</strong> AWS has never woken CrewPoppy to
              check them. This is almost always a pending update — apply the one above, then give
              it five minutes.
            </>
          )}
        </div>
      )}
      {anyScheduled && ticker?.healthy && (
        <p className="muted-2" style={{ margin: 0, fontSize: 12 }}>
          ✓ Schedules are being checked — last at {new Date(ticker.at!).toLocaleTimeString()}
          {ticker.due ? `, ${ticker.due} due` : ", nothing due"}.
        </p>
      )}

      {agents.length === 0 && (
        <>
          <p style={{ margin: 0 }}>
            An AI teammate that does one job well, in your own cloud. Give it a name, a role
            and instructions — then hand it work.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Creating an agent is free. You only pay AWS when it actually runs, and every agent has
            a monthly spending limit you set.
          </p>
        </>
      )}

      {agents.length > 0 && (
        <div className="crew-grid">
          {agents.map((a) => (
            <AgentTile key={a.id} agent={a} models={props.models} onOpen={() => setView({ kind: "chat", id: a.id })} />
          ))}
        </div>
      )}

      <div className="spread">
        <Button className="btn btn-primary" onClick={() => setView({ kind: "create" })}>
          {agents.length === 0 ? "Create your first agent" : "Add another agent"}
        </Button>
        {/* The phone only matters once there's a crew to carry around. */}
        {agents.length > 0 && (
          <button className="btn btn-ghost" onClick={() => setView({ kind: "phone" })}>
            📱 Phone app
          </button>
        )}
      </div>

      <CrewSpreadsheet empty={agents.length === 0} onChanged={refresh} />
    </div>
  );
}

/**
 * The crew as a spreadsheet (founder, 2026-08-01): download it (the same file is the
 * template when the crew is empty), edit or mass-produce rows in Excel, upload to
 * create hundreds in one go. Two-step on purpose: the upload first shows a PLAN —
 * how many created, how many updated, and the combined monthly cap those agents may
 * spend (§9: the money, before the click) — and only "Yes, do it" writes anything.
 * Rows match agents BY NAME; an import never deletes an agent.
 */
function CrewSpreadsheet(props: { empty: boolean; onChanged: () => void | Promise<void> }) {
  const [plan, setPlan] = useState<
    | { csv: string; created: number; updated: number; totalMonthlyCapUsd: number; errors: string[] }
    | null
  >(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 🪤 NOT a blob + `<a download>`: the host renders us in a sandboxed frame, where
  // that silently does nothing at all — a button that looks fine and never produces a
  // file (founder, 2026-08-01). The sidecar writes it and tells us the name.
  const download = async () => {
    setErr(null);
    setDone(null);
    try {
      const { savedAs } = await api.crewCsvSave();
      setDone(`Saved to your Downloads folder as “${savedAs}”. Open it in Excel.`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const picked = async (file: File) => {
    setErr(null);
    setDone(null);
    setPlan(null);
    try {
      const csv = await file.text();
      const r = await api.crewCsvImport(csv, false);
      setPlan({ csv, ...r });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="card" style={{ margin: 0, padding: 12 }}>
      <strong style={{ fontSize: 13 }}>The crew as a spreadsheet</strong>
      <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12 }}>
        {props.empty
          ? "Download the template, fill one row per agent in Excel, and upload it to create them all in one go."
          : "Download your agents as a file Excel opens, edit or add rows, and upload it back. Rows match agents by name — existing names update, new names create, and an upload never deletes anyone."}
      </p>
      <div className="row" style={{ gap: 8 }}>
        <Button className="btn" busyLabel="Saving…" onClick={download}>
          ⬇ {props.empty ? "Save the template to Downloads" : "Save the crew to Downloads"}
        </Button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          ⬆ Upload a spreadsheet
        </button>
        <button className="btn btn-ghost" onClick={() => setPasting((p) => !p)}>
          {pasting ? "Cancel paste" : "…or paste it"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // same file re-picked later must fire again
            if (f) void picked(f);
          }}
        />
      </div>

      {/* The always-works path: select the cells in Excel, copy, paste here. Also the
          way through if the file picker is ever unavailable — the frame we run in is
          sandboxed, and this needs nothing from it but a keystroke. */}
      {pasting && (
        <div style={{ marginTop: 8 }}>
          <textarea
            className="input"
            rows={5}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="Paste the rows here, including the header row (copy them straight from Excel)."
            spellCheck={false}
          />
          <Button
            className="btn"
            busyLabel="Checking…"
            disabled={!pasted.trim()}
            onClick={async () => {
              setErr(null);
              setDone(null);
              setPlan(null);
              try {
                const r = await api.crewCsvImport(pasted, false);
                setPlan({ csv: pasted, ...r });
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Check these rows
          </Button>
        </div>
      )}

      {err && <div className="banner err" style={{ marginTop: 8 }}>{err}</div>}
      {done && <div className="banner" style={{ marginTop: 8 }}>{done}</div>}

      {plan && plan.errors.length > 0 && (
        <div className="banner err" style={{ marginTop: 8 }}>
          <strong>Nothing was changed.</strong> Fix these rows and upload again:
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {plan.errors.slice(0, 12).map((e) => (
              <li key={e} style={{ fontSize: 12 }}>{e}</li>
            ))}
            {plan.errors.length > 12 && <li style={{ fontSize: 12 }}>…and {plan.errors.length - 12} more.</li>}
          </ul>
        </div>
      )}

      {plan && plan.errors.length === 0 && (
        <div className="banner" style={{ marginTop: 8 }}>
          This file creates <strong>{plan.created}</strong> new agent{plan.created === 1 ? "" : "s"} and updates{" "}
          <strong>{plan.updated}</strong>. Together they may spend up to{" "}
          <strong>${plan.totalMonthlyCapUsd.toFixed(2)}/month</strong> — each agent stops at its own cap.
          Nothing is deleted, and nothing has happened yet.
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <Button
              className="btn btn-primary"
              busyLabel="Importing…"
              onClick={async () => {
                try {
                  const r = await api.crewCsvImport(plan.csv, true);
                  if (!r.applied) throw new Error(r.errors[0] ?? "The import was not applied.");
                  setPlan(null);
                  setPasting(false);
                  setPasted("");
                  setDone(`Done — ${r.created} created, ${r.updated} updated.`);
                  await props.onChanged();
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Yes — create {plan.created} and update {plan.updated}
            </Button>
            <button className="btn btn-ghost" onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One agent in the crew grid: face, name, role, and the brief — truncated, because ten
 * briefs at full length is a wall, but expandable in place, because a summary you can't
 * check is a summary you can't trust. The whole tile opens the conversation.
 */
function AgentTile(props: { agent: AgentSummary; models: ModelChoice[]; onOpen: () => void }) {
  const { agent } = props;
  const [expanded, setExpanded] = useState(false);
  const model = props.models.find((m) => m.id === agent.modelId);
  const spent = agent.monthSpendUsd ?? 0;
  const atCap = spent >= agent.caps.monthlySpendCapUsd;

  return (
    <div
      className="tile"
      role="button"
      tabIndex={0}
      aria-label={`Open ${agent.name}`}
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onOpen();
        }
      }}
    >
      <div className="row" style={{ gap: 10, flexWrap: "nowrap", alignItems: "flex-start" }}>
        <Avatar id={agent.avatar} name={agent.name} size={44} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ display: "block" }}>{agent.name}</strong>
          <span className="muted" style={{ fontSize: 12 }}>{agent.role}</span>
        </div>
        <span className={`badge ${atCap ? "warn" : "ok"}`}>
          <span className="dot" /> {atCap ? "At limit" : "Ready"}
        </span>
      </div>
      <p className={`tile-brief${expanded ? "" : " clamped"}`}>{agent.instructions}</p>
      <div className="spread" style={{ marginTop: "auto" }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-expanded={expanded}
        >
          {expanded ? "Less" : "Full instructions"}
        </button>
        <span className="muted-2" style={{ fontSize: 12 }}>
          {agent.schedule?.enabled ? "⏱ " : ""}
          {model?.label ?? agent.modelId} · {money(spent)}
        </span>
      </div>
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
  const [avatar, setAvatar] = useState<string | undefined>(props.agent?.avatar);
  const [helperCopied, setHelperCopied] = useState(false);
  // The pulse stops the moment the button is first used — an invitation, not an alarm.
  const [helperUsed, setHelperUsed] = useState(false);
  // Field 1 of the founder's two-field design (2026-07-29): the approval address, shown
  // HERE because this is where people look for it — but stored install-wide, one address
  // for the whole crew. Saving the agent saves a change to it too.
  const [ownerDraft, setOwnerDraft] = useState(props.owner.email ?? "");
  // Field 2's choices: MailPoppy mailboxes assigned to agents, reported over the bridge.
  const [mailboxes, setMailboxes] = useState<string[]>([]);
  // Field 3: who may START this agent by mail. Default closed — owner only.
  const [openInbox, setOpenInbox] = useState(props.agent?.openInbox ?? false);
  // Where THIS agent's approvals and questions reach the owner (§15i). The owner's
  // explicit choice, per agent — never inferred from a phone being paired. Default
  // email, which is also what every agent saved before this field existed means.
  const [approvalChannel, setApprovalChannel] = useState<"email" | "phone">(
    props.agent?.approvalChannel ?? "email",
  );
  // Only to WARN honestly beside the phone option — the choice itself is never gated
  // on it, because the runner falls back to email whenever the phone is unreachable.
  const [phonePush, setPhonePush] = useState<boolean | null>(null);
  useEffect(() => {
    void api.mobileStatus().then((r) => setPhonePush(r.pushEnabled ?? false)).catch(() => {});
  }, []);
  const [sched, setSched] = useState<AgentSchedule | null>(props.agent?.schedule ?? null);

  useEffect(() => {
    void api.agentMailboxes().then((r) => setMailboxes(r.mailboxes)).catch(() => {});
  }, []);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [senderState, setSenderState] = useState<"unknown" | "checking" | "ok" | "bad">("unknown");
  const [err, setErr] = useState<string | null>(null);
  const ready = name.trim() && role.trim() && instructions.trim() && modelId;

  const notes = new Map((props.catalogue?.tools ?? []).map((t) => [t.name, t]));
  const wantsEmail = (props.catalogue?.needsEmail ?? []).some((t) => chosen.includes(t));
  const granted = [
    ...chosen.map((t) => notes.get(t)?.label ?? t),
    // The open inbox is a grant like any other, so it appears in the same summary,
    // right above the button that grants it.
    ...(wantsEmail && emailFrom.trim() && openInbox
      ? ["Be started by email from anyone — replies to outsiders still wait for your approval"]
      : []),
  ];

  // Ask the BACKEND what this schedule means — the same code the ticker runs. The
  // founder set 20:40 and had no way to know which clock that was in; a second
  // implementation here could have answered confidently and wrongly.
  useEffect(() => {
    if (!sched?.task.trim()) return setPreview(null);
    const t = window.setTimeout(() => {
      void api.previewSchedule(sched).then(setPreview).catch(() => setPreview(null));
    }, 300);
    return () => window.clearTimeout(t);
  }, [sched]);

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
      {/* The AI helper prompt (founder, 2026-07-30): the training IS a prompt. Paste it
          into any AI, add one sentence about the job, get back everything to fill in
          here. Only on CREATE — an edit is a correction, not an onboarding moment. */}
      {!editing && (
        <div className="banner info" style={{ marginBottom: 12 }}>
          <div className="spread">
            <span>
              <strong>New to this?</strong> Copy the helper prompt, paste it into any AI you use
              (Claude, ChatGPT…), and tell it what your agent should do — it answers with
              everything to fill in below.
            </span>
            <button
              className={`btn btn-primary${helperUsed ? "" : " poppy-helper-pulse"}`}
              onClick={async () => {
                await navigator.clipboard.writeText(
                  buildHelperPrompt(props.catalogue ?? { tools: [], groups: [], needsEmail: [] }, props.models),
                );
                setHelperUsed(true);
                setHelperCopied(true);
                window.setTimeout(() => setHelperCopied(false), 2500);
              }}
            >
              {helperCopied ? "Copied ✓" : "✨ Copy the helper prompt"}
            </button>
          </div>
        </div>
      )}
      <div className="grid-2">
        <label className="field">
          <span>Name — what you'll call them</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Emma" />
        </label>
        <label className="field">
          {/* "Role", never "Job title" (founder, 2026-07-29): a person doing this same
              work reads this screen too, and "job title" on a machine lands badly. */}
          <span>Role — the work it does</span>
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Research Assistant" />
        </label>
      </div>
      <div className="field">
        <span style={{ display: "block", fontSize: 12, color: "var(--poppy-muted-2)", marginBottom: 5 }}>
          Pick a face — it's how you'll spot {name.trim() || "this agent"} in the crew
        </span>
        <AvatarPicker value={avatar} name={name} onPick={setAvatar} />
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

      {/* Runs itself (DESIGN §5b). Deliberately plain-language, never a cron string:
          "Every day at 09:00" is something you can check at a glance; "0 9 * * *" is
          something people get wrong and only find out about a week later. */}
      <div className="field">
        <span>Does {name.trim() || "this agent"} run on its own?</span>
        <label className="row" style={{ alignItems: "flex-start", gap: 8, marginTop: 4 }}>
          <input
            type="checkbox"
            checked={!!sched}
            onChange={(e) =>
              setSched(
                e.target.checked
                  ? {
                      kind: "daily",
                      hour: 9,
                      minute: 0,
                      weekday: 1,
                      // Their clock, not the server's — so 09:00 stays 09:00 for them,
                      // including across a daylight-saving change.
                      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                      task: "",
                      enabled: true,
                    }
                  : null,
              )
            }
            style={{ marginTop: 3 }}
          />
          <span style={{ flex: 1 }}>
            <strong style={{ fontSize: 13 }}>Run on a schedule</strong>
            <span className="muted" style={{ display: "block", fontSize: 12 }}>
              It does the job below by itself, whether or not this app is open.
            </span>
          </span>
        </label>

        {sched && (
          <div className="card" style={{ margin: "8px 0 0", padding: 10 }}>
            <div className="grid-2">
              <label className="field" style={{ marginBottom: 8 }}>
                <span>How often</span>
                <select
                  className="select"
                  value={sched.kind}
                  onChange={(e) => setSched({ ...sched, kind: e.target.value as AgentSchedule["kind"] })}
                >
                  <option value="hourly">Every hour</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                </select>
              </label>
              <label className="field" style={{ marginBottom: 8 }}>
                <span>{sched.kind === "hourly" ? "Minutes past the hour" : "At what time"}</span>
                <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  {sched.kind === "weekly" && (
                    <select
                      className="select"
                      value={sched.weekday}
                      onChange={(e) => setSched({ ...sched, weekday: Number(e.target.value) })}
                    >
                      {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
                        (d, i) => (
                          <option key={d} value={i}>{d}</option>
                        ),
                      )}
                    </select>
                  )}
                  {sched.kind !== "hourly" && (
                    <select
                      className="select"
                      value={sched.hour}
                      onChange={(e) => setSched({ ...sched, hour: Number(e.target.value) })}
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{String(h).padStart(2, "0")}</option>
                      ))}
                    </select>
                  )}
                  {/* Only offers what the ticker can actually honour — promising 09:07
                      when we wake every 5 minutes would be a lie in the UI. */}
                  <select
                    className="select"
                    value={sched.minute}
                    onChange={(e) => setSched({ ...sched, minute: Number(e.target.value) })}
                  >
                    {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                      <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
                    ))}
                  </select>
                </div>
              </label>
            </div>
            <label className="field" style={{ marginBottom: 8 }}>
              <span>In which clock?</span>
              <select
                className="select"
                value={sched.timezone}
                onChange={(e) => setSched({ ...sched, timezone: e.target.value })}
              >
                {timezones(sched.timezone).map((tz) => (
                  <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>What should it do each time?</span>
              <textarea
                className="input"
                value={sched.task}
                onChange={(e) => setSched({ ...sched, task: e.target.value })}
                placeholder="Check yesterday's enquiries and email me a short summary."
              />
              {/* The promise, in the reader's own local time, computed by the ticker's
                  own code. If this line is wrong, the schedule is wrong — which is
                  exactly what you want to find out BEFORE waiting for 20:40. */}
              {preview?.nextRunAt ? (
                <small className="muted" style={{ fontSize: 12 }}>
                  {preview.description}. <strong>Next run: {new Date(preview.nextRunAt).toLocaleString()}</strong>{" "}
                  your time. A run already going — or waiting on your answer — is never doubled up.
                </small>
              ) : (
                <small className="muted" style={{ fontSize: 12 }}>
                  Give it a job above and you'll see exactly when it next runs.
                </small>
              )}
            </label>
          </div>
        )}
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

              {/* The honest "no". Greyed out and unclickable, with the real blocker —
                  never phrased so it sounds like installing something switches it on. */}
              {(props.catalogue?.coming ?? [])
                .filter((c) => c.group === g.key)
                .map((c) => (
                  <label
                    key={c.key}
                    className="row"
                    style={{ alignItems: "flex-start", gap: 8, marginTop: 6, opacity: 0.55 }}
                  >
                    <input type="checkbox" checked={false} disabled readOnly style={{ marginTop: 3 }} />
                    <span style={{ flex: 1 }}>
                      <strong style={{ fontSize: 13 }}>
                        {c.label} <span className="chip">not yet</span>
                      </strong>
                      <span className="muted" style={{ display: "block", fontSize: 12 }}>{c.what}</span>
                      <span className="muted-2" style={{ display: "block", fontSize: 12 }}>{c.why}</span>
                    </span>
                  </label>
                ))}
            </div>
          ))}

          {/* Only asked once email is actually wanted — an address field on an agent that
              never emails is a question with no purpose. Two DISTINCT addresses (founder,
              2026-07-29): where approvals go (yours), and what the agent owns (its own). */}
          {wantsEmail && (
            <div className="card" style={{ margin: "0 0 8px", padding: 10 }}>
              <label className="field">
                <span>1 · The email address you use to approve agent tasks</span>
                <input
                  className="input"
                  value={ownerDraft}
                  onChange={(e) => setOwnerDraft(e.target.value)}
                  placeholder="you@yourdomain.com"
                  autoComplete="off"
                  spellCheck={false}
                />
                <small className="muted" style={{ fontSize: 12 }}>
                  Approval requests and agent reports come here. One address for your whole crew —
                  changing it here changes it everywhere.
                </small>
              </label>
              <label className="field" style={{ margin: 0 }}>
                <span>2 · The email address this agent owns</span>
                {mailboxes.length > 0 ? (
                  /* A SELECT of real, assignable addresses — the MailPoppy mailboxes you
                     assigned to agents. No typos, no guessing. A previously saved address
                     that MailPoppy hasn't reported stays selectable rather than vanishing. */
                  <select
                    className="select"
                    value={emailFrom}
                    onChange={(e) => setEmailFrom(e.target.value)}
                  >
                    <option value="">None — it sends from your address, and can't be emailed</option>
                    {[...new Set([...mailboxes, ...(emailFrom ? [emailFrom] : [])])].sort().map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    value={emailFrom}
                    onChange={(e) => setEmailFrom(e.target.value)}
                    placeholder="agent@yourdomain.com"
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                <small className="muted" style={{ fontSize: 12 }}>
                  {mailboxes.length > 0
                    ? "These are the MailPoppy mailboxes you've assigned to AI agents. Mail sent to the chosen address starts this agent, and it sends from it too."
                    : "No MailPoppy mailbox is assigned to agents yet. In MailPoppy, open a mailbox and choose 'Assign this mailbox to an AI agent' — it will appear here. Or type a verified address to send from only."}
                  {emailFrom.trim() && senderState === "checking" && " Checking your AWS account…"}
                  {emailFrom.trim() && senderState === "ok" && " ✓ Your AWS account can send from this address."}
                  {emailFrom.trim() && senderState === "bad" &&
                    " ⚠ Your AWS account hasn't verified this address, so mail from it would bounce."}
                </small>
              </label>
              {/* Only when there IS a door. Opening it widens who can start a run,
                  never what a run may do — the copy says so where the choice is made. */}
              {emailFrom.trim() !== "" && (
                <label className="field" style={{ margin: "8px 0 0" }}>
                  <span>3 · Who may email this agent?</span>
                  <select
                    className="select"
                    value={openInbox ? "anyone" : "owner"}
                    onChange={(e) => setOpenInbox(e.target.value === "anyone")}
                  >
                    <option value="owner">Only me — mail from anyone else is ignored</option>
                    <option value="anyone">Anyone — customers and colleagues too</option>
                  </select>
                  <small className="muted" style={{ fontSize: 12 }}>
                    {openInbox
                      ? "Anyone's email can start this agent — right for a support@ or sales@ address. Its limits don't change: every reply to an outsider still waits for your approval, and the daily-mail and monthly-spend caps still apply."
                      : "The safe default. Only mail from your approval address starts this agent."}
                  </small>
                </label>
              )}
            </div>
          )}

          {/* Where this agent's "needs you" moments reach the owner (§15i). Always
              visible: questions pause runs even for agents with no email tools. The
              choice moves the doorbell, never the door — copy says so in place. */}
          <label className="field" style={{ margin: 0 }}>
            <span>When {name.trim() || "this agent"} needs your OK, reach you…</span>
            <select
              className="select"
              value={approvalChannel}
              onChange={(e) => setApprovalChannel(e.target.value === "phone" ? "phone" : "email")}
            >
              <option value="email">By email — a link to your approval address</option>
              <option value="phone">On your phone — a notification from the CrewPoppy app</option>
            </select>
            <small className="muted" style={{ fontSize: 12 }}>
              {approvalChannel === "phone"
                ? "Your phone buzzes instead of an email arriving. Approvals still wait exactly the same way — and if no phone is listening (app deleted, notifications off), the email link is sent instead, so nothing can wait unseen."
                : "The default. Approval requests and questions arrive at your approval address as a link."}
              {approvalChannel === "phone" && phonePush === false &&
                " ⚠ No phone has notifications on right now — until one does, approvals will arrive by email."}
            </small>
          </label>

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
              // The approval address is install-wide; a change here is saved first, with
              // the same SES verification as the Email card, so it can't silently rot.
              if (ownerDraft.trim() && ownerDraft.trim() !== (props.owner.email ?? "")) {
                await api.setOwnerEmail(ownerDraft.trim());
              }
              await api.saveAgent({
                ...(props.agent ? { id: props.agent.id } : {}),
                name,
                role,
                instructions,
                modelId,
                tools: chosen,
                emailFrom: emailFrom.trim(),
                openInbox,
                approvalChannel,
                avatar: avatar ?? "",
                schedule: sched && sched.task.trim() ? sched : null,
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

/**
 * The owner's window into one agent's workspace (DESIGN §3). Results an owner can't
 * open aren't results — an agent could "save the report" forever and the owner would
 * never see a byte of it. Loaded only when opened: files are the exception, not the
 * default, and an idle disclosure costs nothing.
 */
function FilesPanel(props: { agent: AgentSummary }) {
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [viewing, setViewing] = useState<{ path: string; content: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  /** The one file whose Delete has been clicked once and is awaiting confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(
    () => api.listFiles(props.agent.id).then((r) => setFiles(r.files)).catch((e) => setErr((e as Error).message)),
    [props.agent.id],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

  if (!files && !err) {
    return (
      <p className="row muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
        <span className="spinner" /> Looking in {props.agent.name}'s folder…
      </p>
    );
  }

  // The founder's template story (2026-07-28): put invoice-template.md in the agent's
  // folder, tell it to follow that template, and it reads the file itself. The form is
  // paste-a-text-file on purpose — the sandboxed webview has no file picker, and a
  // template is text by nature.
  const addForm = adding ? (
    <div className="card" style={{ margin: 0 }}>
      <label className="field">
        <span>File name — e.g. invoice-template.md</span>
        <input
          className="input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="invoice-template.md"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label className="field" style={{ margin: 0 }}>
        <span>Contents</span>
        <textarea
          className="input"
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder={"## Invoice {number}\n\n| Item | Qty | Price |\n|---|---|---|"}
        />
        <small className="muted" style={{ fontSize: 12 }}>
          Lands in {props.agent.name}'s own folder. Tell {props.agent.name} in its instructions to
          read this file and follow it — a template it can read beats one it has to remember.
        </small>
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        <Button
          className="btn btn-primary"
          disabled={!newName.trim() || !newContent.trim()}
          busyLabel="Saving…"
          onClick={async () => {
            setErr(null);
            try {
              await api.putFile(props.agent.id, newName.trim(), newContent);
              setAdding(false);
              setNewName("");
              setNewContent("");
              await reload();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Save file
        </Button>
        <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
      </div>
    </div>
  ) : (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
        Add a file… <span className="muted-2">(a template, reference notes)</span>
      </button>
    </div>
  );

  if (files && files.length === 0) {
    return (
      <div className="stack" style={{ marginTop: 8 }}>
        {err && <div className="banner err">{err}</div>}
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {props.agent.name} hasn't saved any files yet.
        </p>
        {addForm}
      </div>
    );
  }

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      {err && <div className="banner err">{err}</div>}
      {(files ?? []).map((f) => (
        <div key={f.path} className="spread">
          <button
            className="btn btn-ghost btn-sm mono"
            onClick={async () => {
              setErr(null);
              setCopied(false);
              try {
                // A PDF is bytes, not text: it opens in the browser via a five-minute
                // signed link to the owner's own bucket. Text shows inline as before.
                if (f.path.toLowerCase().endsWith(".pdf")) {
                  const { url } = await api.fileLink(props.agent.id, f.path);
                  await host.openExternal(url);
                } else {
                  setViewing(await api.readFile(props.agent.id, f.path));
                }
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            {f.path}
            {f.path.toLowerCase().endsWith(".pdf") ? " ↗" : ""}
          </button>
          <span className="row" style={{ gap: 8 }}>
            <span className="muted-2" style={{ fontSize: 12 }}>
              {kb(f.size)}
              {f.modified ? ` · ${new Date(f.modified).toLocaleString()}` : ""}
            </span>
            {/* Deleting a file is destructive and irreversible, so it takes two
                deliberate clicks and names the file in between — never one bare
                click on a row you might have been aiming past (AGENTS.md §9). */}
            {confirming === f.path ? (
              <>
                <Button
                  className="btn btn-danger btn-sm"
                  busyLabel="Deleting…"
                  onClick={async () => {
                    setErr(null);
                    try {
                      await api.deleteFile(props.agent.id, f.path);
                      setConfirming(null);
                      if (viewing?.path === f.path) setViewing(null);
                      await reload();
                    } catch (e) {
                      setErr((e as Error).message);
                    }
                  }}
                >
                  Delete {f.path}?
                </Button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)}>
                  Keep
                </button>
              </>
            ) : (
              <button
                className="btn btn-ghost btn-sm"
                title={`Delete ${f.path}`}
                onClick={() => setConfirming(f.path)}
              >
                Delete
              </button>
            )}
          </span>
        </div>
      ))}

      {addForm}

      {viewing && (
        <div className="card" style={{ margin: 0 }}>
          <div className="spread" style={{ marginBottom: 6 }}>
            <strong className="mono" style={{ fontSize: 13 }}>{viewing.path}</strong>
            <div className="row" style={{ gap: 4 }}>
              {/* Copy, not download: the sandboxed webview has no file-save dialog, and a
                  copy button that works beats a download button that silently doesn't. */}
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(viewing.content);
                  setCopied(true);
                }}
              >
                {copied ? "Copied ✓" : "Copy contents"}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setViewing(null)}>
                Close
              </button>
            </div>
          </div>
          <pre
            className="mono"
            style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, maxHeight: 280, overflowY: "auto" }}
          >
            {viewing.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function AgentRow(props: {
  agent: AgentSummary;
  models: ModelChoice[];
  catalogue: ToolCatalogue | null;
  owner: OwnerEmail;
  onChanged: () => Promise<void>;
  /** The way home — this row is now a full page, not one card in a column. */
  onBack: () => void;
}) {
  const { agent } = props;
  const [editing, setEditing] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
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
  const [confirmClear, setConfirmClear] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
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

  // Keep the freshest run reachable inside the idle checker without re-arming it.
  const runRef = useRef<RunRecord | null>(null);
  runRef.current = run;

  // Scheduled runs happen with nobody watching (DESIGN §5b): re-attach to the newest run
  // on mount and keep looking while idle. Without this, a run the ticker started —
  // including one that failed — was completely invisible: the card only ever tracked
  // runs begun from its own composer, and the founder stared at a silent card while
  // "1 due" sat in the heartbeat line.
  useEffect(() => {
    let gone = false;
    const attach = async () => {
      try {
        const { runs } = await api.listRuns(agent.id);
        // Newest by START TIME, not list order: scheduled ids ("sched-…") and UI ids
        // (uuids) interleave arbitrarily in the sort key.
        const newest = runs.reduce<RunRecord | null>(
          (a, b) => (!a || Date.parse(b.startedAt) > Date.parse(a.startedAt) ? b : a),
          null,
        );
        if (!gone && newest && newest.runId !== runRef.current?.runId) {
          setRun(newest);
          void poll(newest.runId);
        }
      } catch {
        /* transient — the next pass tries again */
      }
    };
    void attach();
    const t = window.setInterval(() => {
      const r = runRef.current;
      if (!r || (r.status !== "running" && r.status !== "waiting")) void attach();
    }, 30_000);
    return () => {
      gone = true;
      window.clearInterval(t);
    };
  }, [agent.id, poll]);

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

  const send = async () => {
    const text = task.trim();
    if (!text) return;
    setErr(null);
    setTask("");
    try {
      const r = await api.startRun(agent.id, text);
      setRun(r);
      // The task appears immediately rather than after the first poll: a chat box that
      // swallows your message for two seconds feels broken, whatever it's doing.
      setTranscript((t) => [...t, { seq: -1, role: "user", text }]);
      void poll(r.runId);
    } catch (e) {
      setTask(text); // don't lose what they typed
      setErr((e as Error).message);
    }
  };

  // Follow the conversation, like any chat window does.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length, run?.status]);

  const spent = agent.monthSpendUsd ?? 0;
  const atCap = spent >= agent.caps.monthlySpendCapUsd;

  return (
    <div className="card card-2" style={{ margin: 0 }}>
      <div>
        <button className="btn btn-ghost btn-sm" onClick={props.onBack}>
          ← Your crew
        </button>
      </div>
      <div className="spread" style={{ alignItems: "flex-start", marginTop: 8 }}>
        <div className="row" style={{ gap: 10, flexWrap: "nowrap", alignItems: "flex-start" }}>
          <Avatar id={agent.avatar} name={agent.name} size={44} />
          <div>
          <div className="row" style={{ gap: 8 }}>
            <strong>{agent.name}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {agent.role}
            </span>
          </div>
          <p className="muted-2" style={{ margin: "4px 0 0", fontSize: 12 }}>
            {agent.nextRunAt
              ? `Next run ${new Date(agent.nextRunAt).toLocaleString()} · `
              : agent.schedule?.enabled
                ? `${describeSchedule(agent.schedule)} · `
                : ""}
            {agent.tools?.length ? `Can: ${agent.tools.length} tool${agent.tools.length === 1 ? "" : "s"} · ` : ""}
            Thinks with <strong>{model?.label ?? agent.modelId}</strong>
            {model ? ` (${model.cost})` : ""} · this month: {money(spent)} of $
            {agent.caps.monthlySpendCapUsd.toFixed(2)} limit
          </p>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {/* The badge tells the truth about NOW: a run in flight is "Working", a run
              waiting on the owner is "Needs you" — "Ready" while visibly busy was a lie
              the founder caught in a screenshot (2026-07-30). */}
          <span
            className={`badge ${
              atCap ? "warn" : run?.status === "waiting" ? "warn" : run?.status === "running" ? "run" : "ok"
            }`}
          >
            <span className="dot" />{" "}
            {atCap
              ? "At limit"
              : run?.status === "waiting"
                ? "Needs you"
                : run?.status === "running"
                  ? "Working"
                  : "Ready"}
          </span>
          {/* Capabilities can be taken back as well as given — a grant you can't revoke
              isn't really a grant. */}
          <button className="btn btn-ghost" onClick={() => setShowFiles((v) => !v)}>
            Files{showFiles ? " ▾" : "…"}
          </button>
          <button className="btn btn-ghost" onClick={() => setEditing(true)}>
            Edit…
          </button>
          <DeleteAgent agent={agent} onDeleted={props.onChanged} />
        </div>
      </div>

      {showFiles && <FilesPanel agent={agent} />}

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

      {/* The conversation, as a conversation. Your words on the right, theirs on the
          left, what they DID centred and quiet in between. Bounded and scrollable
          because several agents share this page: an unbounded trail pushes the next
          agent off screen, which is what made it hard to tell whose was whose. */}
      <div className="chat" style={{ marginTop: 10 }}>
        <div className="chat-log" ref={logRef}>
          {transcript.length === 0 && !run && (
            <p className="chat-empty">
              Nothing yet. Give {agent.name} something to do below.
            </p>
          )}
          {transcript.map((t) =>
            t.role === "tool" ? (
              // Visible, never hidden (DESIGN §9) — but it's machinery, not speech.
              <div key={t.seq} className="msg step">
                <div className="msg-body">⚙ {t.text}</div>
              </div>
            ) : (
              <div key={t.seq} className={`msg ${t.role === "user" ? "you" : "agent"}`}>
                <span className="msg-who">{t.role === "user" ? "You" : agent.name}</span>
                <div className="msg-body">{t.text}</div>
              </div>
            ),
          )}
          {run?.status === "running" && (
            <div className="msg agent">
              <span className="msg-who">{agent.name}</span>
              <div className="msg-body row" style={{ gap: 8 }}>
                <span className="spinner" />
                <span className="muted">Working… this keeps going if you leave.</span>
              </div>
            </div>
          )}
        </div>

        <div className="chat-composer">
          <textarea
            className="input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={
              run?.status === "waiting"
                ? `${agent.name} is waiting for your answer below…`
                : `Message ${agent.name}…`
            }
            aria-label={`Message ${agent.name}`}
            disabled={run?.status === "waiting"}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter makes a new line — what every chat box does.
              const busy = run?.status === "running" || run?.status === "waiting";
              if (e.key === "Enter" && !e.shiftKey && task.trim() && !busy) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            className="btn btn-primary"
            disabled={!task.trim() || run?.status === "running" || run?.status === "waiting"}
            busyLabel="…"
            onClick={send}
          >
            Send
          </Button>
          {/* The kill switch (DESIGN §7). Always reachable while a run is live. */}
          {run?.status === "running" && (
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
          )}
        </div>
      </div>
      {/* Clear the conversation (founder request, 2026-07-28). Real deletion, so it gets
          a real second step — inline, webview-safe — and an honest scope line: memory,
          files and the month's spend all survive. Tidying up never resets a cap. */}
      {(transcript.length > 0 || run) && (
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 4 }}>
          {confirmClear ? (
            <>
              <span className="muted" style={{ fontSize: 12 }}>
                Delete this whole conversation and its run history? {agent.name}'s memory, files
                and spending record stay.
              </span>
              <Button
                className="btn btn-danger btn-sm"
                busyLabel="Clearing…"
                onClick={async () => {
                  setErr(null);
                  try {
                    await api.clearHistory(agent.id);
                    setRun(null);
                    setTranscript([]);
                    setPending(null);
                    setConfirmClear(false);
                  } catch (e) {
                    setErr((e as Error).message);
                    setConfirmClear(false);
                  }
                }}
              >
                Yes, clear it
              </Button>
              <button className="btn btn-sm" onClick={() => setConfirmClear(false)}>
                Keep
              </button>
            </>
          ) : (
            // A real button, not whispered text (founder, 2026-07-30): tidying up is a
            // feature people need to FIND. Danger-styled because it deletes — the
            // inline second step above stays the actual guard.
            <button className="btn btn-danger btn-sm" onClick={() => setConfirmClear(true)}>
              🧹 Clear chat…
            </button>
          )}
        </div>
      )}
      {err && <div className="banner err" style={{ marginTop: 8 }}>{err}</div>}

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
              {pending.attach && (
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted" style={{ fontSize: 12, minWidth: 56 }}>Attached</span>
                  {/* Openable, not just named: approving an attachment you haven't
                      opened is not approval. Same file, same bucket, same bytes the
                      send will fetch. */}
                  <button
                    className="btn btn-ghost btn-sm mono"
                    onClick={async () => {
                      try {
                        const { url } = await api.fileLink(agent.id, pending.attach!);
                        await host.openExternal(url);
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    }}
                  >
                    {pending.attach} ↗
                  </button>
                </div>
              )}
              <div style={{ whiteSpace: "pre-wrap", borderTop: "1px solid var(--poppy-border)", paddingTop: 8 }}>
                {pending.body}
              </div>
            </div>
          ) : null}

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

      {/* The footer of a finished run: what it cost, and anything that went wrong.
          The words themselves are already above, in the conversation. */}
      {run && run.status !== "running" && run.status !== "waiting" && (
        <div className="stack" style={{ marginTop: 10 }}>
          {run.message && <div className="banner info">{run.message}</div>}
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
        </div>
      )}

    </div>
  );
}
