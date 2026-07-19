# CrewPoppy — DESIGN

*Product name locked 2026-07-19: **CrewPoppy**, tagline "Mission Control for your AI crew."*

Create a fleet of task-specific AI agents that run **entirely in your own AWS account** — their
prompts, their memory, their outputs, their token spend, all in your cloud. Give an agent
instructions and a set of tools, run it on demand or on a schedule, and watch exactly what it
costs. No agent-platform vendor ever sees your prompts, your data, or what your agents do.

An [AgentsPoppy](https://agentspoppy.com) poppy — and the most on-brand one possible: AI agents
that run in your own cloud, on a platform for apps that run in your own cloud. Status: **§17**.
Source of truth for all product/architecture decisions; update this file when a decision changes.

---

## 1. Positioning — why this beats the agent-platform crowd

The market (OpenAI Assistants/GPTs, LangChain/LangSmith, CrewAI, AutoGPT-likes, n8n AI, Zapier
agents) puts a **vendor in the middle**: your prompts, your data, your agents' actions, and your
billing all flow through someone else's cloud.

- **No vendor in the loop — agents run in *your* AWS.** Definitions, memory, transcripts, outputs,
  and logs live in your DynamoDB/S3. Nobody else can read your prompts or see what your agents do.
  The compliance story collapses from "trust our vendor" to "there is no vendor."
- **Tokens bill to your own AWS via Amazon Bedrock.** No separate AI subscription, no per-seat SaaS
  — inference is a line on your AWS bill, under your control, with **hard spend caps** you set.
- **A runaway agent can't surprise you.** Per-run iteration/token/wall-clock limits, per-agent
  monthly spend caps, a global ceiling, a kill switch, and a live cost meter — the "show the money"
  rule (AGENTS.md §9) is *load-bearing* here, not decorative.
- **Your agents' work is an open surface.** Outputs and memory sit in your own S3/DynamoDB, so any
  BI/automation tool can read them — the lock-in-free integration story SaaS agents can't offer.
- **Unlimited agents.** No per-agent or per-seat pricing — you pay AWS for what actually runs.
- **Your agents are a file you own — zero lock-in.** An agent is just data (definition + memory +
  workspace, §3b); export the whole crew as a "Crew Pack" and re-import it anywhere. On a SaaS
  platform your agent's accumulated context is trapped in the vendor; here it moves with you —
  across regions, accounts, or a teardown-and-rebuild — with no re-learning.
- **AgentsPoppy guarantees:** tagged resources, tight name-scoped permissions, teardown +
  leaves-no-trace certification, and cost visibility.

### 1b. Honest posture — what we bound, and the real risks (ship this in-app)

AI agents that *act* carry real risk; we're explicit about how we contain it:
- **Agents never get your AWS credentials.** An agent can only call a **fixed, curated set of
  tools** the poppy implements (§4) — never the raw AWS SDK. A misbehaving or prompt-injected agent
  cannot reach into your account, delete resources, or run up arbitrary services. This is the whole
  safety design (§4, §9).
- **Prompt injection is real.** An agent that fetches web pages or reads untrusted input can be
  manipulated. We mitigate (tool outputs are data, never new instructions; tools are least-privilege
  and per-agent scoped; destructive tools require confirmation; caps bound the blast radius) but we
  say plainly: **don't give an agent a tool you wouldn't want a stranger triggering.**
- **Spend is capped, not uncapped.** Every agent has a spend ceiling; runs stop at hard limits. You
  can't wake up to a surprise Bedrock bill.
- **Not AGI, not autonomous-forever.** These are bounded, task-specific runs — an agent does a job
  and stops. "Trained" here means **instructions + tools**, not fine-tuning.

## 2. Architecture

```
AgentsPoppy container (the dashboard)        Your AWS account (chosen region)
┌───────────────────────────────┐            ┌──────────────────────────────────────────────┐
│ define agents (prompt, model, │            │ DynamoDB: agent defs · memory · run transcripts│
│  tools, trigger, caps)        │  scoped    │ S3: per-agent workspace (files/artifacts)      │
│ run now / schedule            │  creds     │ agent-runner Lambda  ── invokes ──► Bedrock    │
│ LIVE cost meter + kill switch │ ─────────► │   (the agentic loop; enforces caps)            │
│ run history + transcripts     │            │ tool-dispatcher (TRUSTED): mediates every tool │
└───────────────────────────────┘            │   call, per-agent scoped — agents never touch  │
                                             │   AWS directly                                 │
                                             │ EventBridge: scheduled triggers · Logs         │
                                             └──────────────────────────────────────────────┘
```

- **One deploy, VM-Poppy/MailPoppy-style**, via the embedded-template CloudFormation pipeline
  (MailPoppy's `backend-bundle`): DynamoDB + S3 + the runner/dispatcher Lambdas + EventBridge +
  the Bedrock permission + a Cognito plane for the dashboard/API (like MailPoppy's access API).
- **The poppy screen IS Mission Control:** define agents, run them, watch cost, read transcripts.

## 3. What an "agent" is (the data model)

An agent is a stored definition (DynamoDB), not code:
- **persona**: given name (+ optional family name) — "Emma", "Emma Smith" — so the crew feels like
  a team and signatures are consistent. **Disclosure stance (EU AI Act Art. 50 + similar):**
  personas are encouraged, but the app's guidance (and template signatures) never *claim
  humanity* to third parties — "Emma from <company>" yes, "I am a human" never; in-app copy tells
  owners that customer-facing agents must be disclosable as AI where law requires. Protects
  CrewPoppy's users, keeps the warmth.
- **role title** (owner-assigned, freeform): "Social Media Manager", "Research Assistant" —
  displayed on the card and used in the persona preamble.
- **avatar** (optional): a monogram by default, or an AI-generated synthetic face (§3c).
- **instructions** (the system prompt — the brief: what the agent does, tone, cadence, rules like
  "always ask before publishing")
- **model** (a Bedrock model id; default: Claude on Bedrock — the founder builds on Claude)
- **tools** (a subset of the curated tool catalogue §4 the agent may use)
- **trigger**: on-demand · scheduled (cron via EventBridge) · *(post-MVP: webhook/event)*
- **input schema** (optional — parameters a run accepts, e.g. a topic or URL)
- **caps**: max iterations/run, max tokens/run, max wall-clock/run, **monthly spend cap ($)**
- **memory**: on/off — whether the agent keeps persistent memory across runs (its own DynamoDB
  items + S3 workspace)

Agent defs are **just data in your account** → fully portable, no lock-in. "Create unlimited
agents" is literal: they're rows, essentially free until run.

### 3b. Portability — the "Crew Pack" (knowledge survives teardown)

First, a precise mental model: an agent doesn't "learn" the way a model is trained — **its weights
never change.** What accumulates is **data in your account**: the agent definition (persona, role,
the instructions you refined), its **memory** (facts, your preferences, style guides, approved
examples), its **workspace files** (S3), and its run transcripts. "Emma got better" = that data got
richer, not that a model was retrained. Because it's all just data, it is **fully exportable** — a
core AgentsPoppy no-lock-in guarantee, and the answer to your teardown worry:

- **Export → "Crew Pack":** one click bundles chosen agents (or the whole crew) — defs + memory +
  workspace + optional transcripts — into a portable archive (a JSON manifest + files).
- **Import:** a fresh deployment — after a teardown, or in a new region/account — **re-hydrates from
  the pack**, and the agents come back with everything they knew. **Zero re-learning.**
- **Teardown offers the Crew Pack FIRST** (the TrafficPoppy pattern): "Download your Crew Pack
  before removing everything?" — so a teardown can never silently erase what your crew learned.
- **Honest note — what does NOT auto-travel:** account-specific *secrets and authorizations* —
  OAuth tokens for external publishers (Buffer/Zapier), verified SES email identities, allowlisted
  webhook URLs — are re-connected in the new account, because they're credentials tied to *that*
  account by design. **The brain travels; the external plumbing is reconnected** (a short setup
  step, not re-learning).
- **Bonus payoffs of the same format:** clone an agent, share/template a whole crew (the post-MVP
  template library), or move regions for data residency — all just import a Crew Pack.
- **Post-MVP backup:** optional scheduled auto-export of Crew Packs to the owner's own S3 (and/or
  DynamoDB point-in-time recovery), so even an *accidental* teardown is recoverable.

### 3c. Faces — optional AI-generated avatars (adoption feature)

People engage far more with a teammate that has a face — an avatar turns "an agent" into "Emma,"
and that emotional pull is a genuine driver of adoption, not a gimmick. **Optional** (off by
default; the cheap default avatar is a colored monogram/initial).

- **Generated in YOUR cloud, via Bedrock image models** (Amazon Nova Canvas / Titan Image Generator
  / Stability on Bedrock) — same trust boundary and billing as text inference, no external image
  vendor. The face is **synthetic: a novel person the AI invents, who does not exist** — never a
  photo of a real person and never scraped from the web, so there's no real-likeness or copyright
  exposure.
- **Appearance is owner-controlled.** The app *suggests* a starting point from the name (a
  female-presenting portrait for "Emma," male for "Marco") but it's only a suggestion — the owner
  sets gender, approximate age, and style (photoreal / illustrated) and **regenerates until happy.**
  Name→gender is a heuristic, always overridable; unisex names, any presentation, and
  non-gendered/abstract avatars are all first-class (no rigid name→gender rule baked in).
- **One-time and cheap.** Generated once at agent creation, stored in the agent's S3 workspace as
  its `avatar`; a few cents of Bedrock image cost, shown in the meter. Travels inside the Crew Pack
  (§3b), so a re-imported agent keeps its face.
- **Honesty guardrail (ties to §3 disclosure).** A synthetic face + a human name makes an agent
  *feel* human — wonderful for your own dashboard and team adoption, but for **customer-facing**
  agents it must stay disclosable as AI where law requires (EU AI Act Art. 50). There are TWO
  distinct obligations, and CrewPoppy addresses both — don't conflate them:
  - **"This image is AI-generated"** (EU AI Act Art. 50(2) synthetic-media + C2PA trend). Solved at
    the image: every generated avatar carries a small visible **"AI Avatar" watermark** placed in a
    corner that never occludes the face, PLUS **embedded provenance metadata / C2PA content
    credentials** in the file (invisible, survives cropping the visible mark — belt-and-braces,
    since a visible watermark alone can be edited out). Bedrock's image models can emit an invisible
    watermark; we add the visible label + credentials on top. On by default, not removable in the
    app (removing it would defeat the disclosure).
  - **"You are interacting with an AI"** (EU AI Act Art. 50(1), CA bot law). NOT covered by the
    watermark, because the avatar image usually isn't present where the interaction happens (email
    body, social caption, a chat where the avatar is a 24px circle or absent). This disclosure must
    live in the **conversation** — an email-footer line, a chat intro note — so the app's
    customer-facing templates carry it and the guidance says so.
  - Framing throughout: avatars "give your crew a face," never "convince outsiders they're human."

## 4. The tool system — the safety crux (recursive broker pattern)

**The core tension:** an AI agent's value is *doing things*, but AgentsPoppy's whole model is
*tight, bounded* permissions. If agents could make arbitrary AWS calls, the permission set would be
enormous (red rating, STS budget overflow, security nightmare), and a prompt-injected agent could
wreck the account. Resolution — **the same pattern AgentsPoppy uses on poppies, applied again to
agents:**

- Just as the **broker** mediates a *poppy's* AWS access (scoped, approved, attributed), the
  **tool-dispatcher** mediates an *agent's* tool access. The agent never holds AWS credentials and
  never calls the AWS SDK. It can only emit **tool calls** — function invocations the dispatcher
  implements and executes on its behalf, **enforcing per-agent scope** every time.
- Tools are a **fixed, curated catalogue** — not "any AWS action." Adding a tool is an engineering
  decision with its own bounds, never something an agent can escalate into.
- Every tool is **per-agent scoped server-side**: agent X's file tool only ever touches agent X's S3
  prefix; its memory tool only its own DynamoDB items. One agent can't read another's data (§9).

**MVP tool catalogue (all mediated, all bounded):**
- `web_fetch` / `web_search` — read the web (read-only). *The main prompt-injection surface — output
  is treated as data, never instructions; flagged to the user when enabled.*
- `workspace_read` / `workspace_write` — the agent's **own** S3 prefix only (files/artifacts).
- `memory_read` / `memory_write` — the agent's **own** persistent memory (DynamoDB).
- `send_email` — via SES, **to the owner's verified address(es) only** in MVP (report delivery
  without an open spam vector).
- `http_request` — POST to an **owner-allowlisted** endpoint only (webhook out to your systems).
- **`ask_user` — the human-in-the-loop tool (load-bearing, MVP).** The agent asks the owner a
  question or requests approval mid-task: *"I drafted this reply to the customer — approve?"*,
  *"Here's today's social post — publish?"*. Calling it **suspends the run** (§5), notifies the
  owner (dashboard inbox; push on mobile, §15), and **resumes with the answer** when they reply —
  approve / deny / free-text. This is the supervised-approval pattern that defines AgentsPoppy,
  applied to the agents themselves: consequential actions can be gated on a human *by the agent's
  own definition* ("always ask before sending"). It's also what makes agents trustworthy enough
  to give real jobs.

**Post-MVP tools:** `invoke_agent` (one agent calls another — the multi-agent story, §15), broader
`http_request`, read-only access to *other poppies'* data via their APIs (powerful; careful),
**platform connectors** (publish to Facebook/Instagram via the Meta Graph API, X, LinkedIn — each
needs owner-connected accounts + platform app review, and X's API is a paid tier, so these are
deliberate per-platform additions, honestly scoped). **MVP path for the social-manager use case:**
the agent DRAFTS (model knowledge), routes drafts through `ask_user` for approval, and publishes
via the allowlisted `http_request` webhook to the owner's Buffer/Zapier/Make — real publishing on
day one without waiting for native connectors.

### 4b. Knowledge vs. ability — "how does the agent know what to do without training?"

The single most common misconception. Two different things hide inside "does the agent know what
to do," and they have **opposite** answers:

- **Knowing HOW (the skill): already there — no training needed.** The model (Claude) was
  pretrained on a vast slice of the web — millions of social posts, marketing copy, brand voices,
  emails, code. It ALREADY knows what a good Facebook vs. Instagram vs. X post looks like: length,
  tone, hashtag norms, a call to action. You don't teach it that; you **steer** it with the persona
  + instructions ("You are Emma, Social Media Manager for <brand>. Voice: warm, witty. Post daily.
  Never touch politics. Always end with a CTA."). Brief + built-in skill = it knows what to write.
  Verify in ten seconds: run it, read the draft.
- **Being ABLE to act (publishing): the real gap — and it's TOOLS, not training.** The model can
  *write* the post; it cannot, by itself, *publish* it to your Facebook — that needs software that
  calls Facebook's API. That's a **tool** we build (§4: the MVP webhook path, or post-MVP native
  connectors), and it's the genuine work — not because the agent needs "training," but because each
  platform has its own API, OAuth, app review, and rules.

**So the reframe: you don't train the agent — you brief it, test it, and supervise it until you
trust it.** The confidence ladder (this is the design's answer, and the app guides owners through
it):
1. **Brief** — write good instructions + persona (the job description).
2. **Test / dry-run** — run it, read the output, refine the brief. This is the practical substitute
   for "training": you iterate the *prompt*, not the model weights. A few cycles and Emma's posts
   are consistently on-voice.
3. **Sharpen with examples + memory** — paste a few approved posts as examples (few-shot), give her
   a style guide in memory. Quality jumps; still no training.
4. **Gate the consequential step with `ask_user`** — in production she DRAFTS, then asks "publish
   this?"; you approve / deny / edit. She never posts unreviewed until you allow it.
5. **Graduate** — once a week of approvals shows she's reliable, loosen the gate (auto-publish
   low-stakes, keep approval for high-stakes). The design supports both ends of the leash.

**Rule of thumb by stakes:** reversible / low-stakes (draft an email for you) → trust fast.
Irreversible / public / spends money / faces customers → keep `ask_user` longer. CrewPoppy defaults
consequential tools behind approval and the app nudges owners to *test before automating*.

**Honest bottom line for the social example:** "Emma knows how to write great posts" is true today,
out of the box. "Emma auto-publishes to your FB/IG/X" needs the connectors (post-MVP) or the
webhook-to-Buffer/Zapier path (MVP) — and either way you'll want her behind `ask_user` until you
trust her. No fine-tuning anywhere in that story.

## 5. Execution model

- **`agent-runner` Lambda per run.** The agentic loop: load def → call Bedrock (system prompt +
  tool schemas) → on a tool call, hand to the tool-dispatcher (which enforces scope) → feed the
  result back → repeat until the model finishes **or a guardrail trips** (max iterations / tokens /
  wall-clock / spend). Then write the transcript + outputs to the agent's DynamoDB/S3.
- **Guardrails are enforced in the loop, not hoped for** (§7). A run that hits a limit stops cleanly
  and records why.
- **Triggers:** on-demand (dashboard "Run") and **scheduled** (EventBridge cron — "every morning,
  summarize my inbox"). Post-MVP: webhook/event triggers.
- **Suspend/resume (the `ask_user` mechanic).** A Lambda can't block for hours waiting on a human,
  so when an agent calls `ask_user` the runner **checkpoints the run** (full conversation state +
  the pending question to DynamoDB) and exits cleanly; the run shows as **"waiting for you"**. When
  the owner answers — dashboard or mobile — a fresh runner invocation **resumes from the
  checkpoint** with the answer appended. Same converging/TTL discipline as broker approvals: one
  pending question per run (no stacking), and an unanswered question expires the run gracefully
  after N days rather than dangling forever. Deterministic-state rule: the checkpoint is the whole
  truth; resuming must not re-execute earlier tool calls (idempotency, the family lesson).
- **Lambda's 15-min cap** bounds a single *segment* — and suspend/resume means a task with human
  gates spans segments naturally. Long-running/expensive agents are a **post-MVP Fargate**
  execution target (noted so we don't over-build now).

## 6. LLM inference — Amazon Bedrock (tokens bill to your AWS)

- **Bedrock-first**, in the owner's account, chosen region. Inference bills to their AWS like
  everything else — no external vendor, no API-key custody, on-brand. Default model: **Claude on
  Bedrock**.
- **Bedrock model access is an account opt-in** (the owner enables model access in the Bedrock
  console once — like SES sandbox, a one-time gate we surface + link, can't click for them).
  Region-limited per model — confirm availability like SES inbound regions.
- **Owner-supplied API key (Anthropic/OpenAI) is a post-MVP option** for models Bedrock lacks —
  stored as a secret in the owner's account; explicitly *re-introduces* an external vendor, so it's
  opt-in and labelled, never the default.

## 7. Cost guardrails — "Show the money," and hard stops (the most important section)

LLM tokens + an agent in a loop = the fastest way to a surprise bill in the whole poppy family. So
the controls are **hard mechanisms**, not advice:
- **Per run:** max iterations (default e.g. 8), max tokens, max wall-clock. The runner enforces all
  three and stops at the first hit.
- **Per agent:** a **monthly spend cap ($)** — the runner refuses to *start* a run that could exceed
  it, and stops mid-run if crossed. Default cap on every new agent (never unlimited by default).
- **Per deployment:** a global monthly ceiling across all agents.
- **Kill switch:** stop a running agent immediately (invalidate its run, halt the loop).
- **Live cost meter:** Bedrock token usage per run/agent × the model's live token rates (Price List
  API — never hardcoded) → "This run: 12k in / 3k out ≈ **$0.06**"; "Research-Agent this month:
  **$2.10 / $10 cap**." This is the reference implementation of the AGENTS.md §9 rule.
- **Estimate before run:** show an expected-cost range before an on-demand run; warn on scheduled
  agents ("runs daily ≈ $X/mo at current usage").
- **One-off costs surfaced too:** avatar generation (§3c) is a one-time few-cents Bedrock image
  charge, shown when the owner generates a face — never a hidden line.

## 8. Permission set & rating

The widest set in the family so far — MailPoppy-class amber, name-scoped `MissionControlAgents*`:
- `dynamodb`: agent defs / memory / transcripts (tagged-as-self) · `s3`: per-agent workspaces
  (tagged-as-self) · `lambda`: the runner/dispatcher (own functions) · `bedrock`:
  `InvokeModel`/`InvokeModelWithResponseStream` (covers BOTH text inference and §3c image
  avatars — same action, different model ids) (+ `ListFoundationModels` read) · `events`
  (EventBridge schedules, name-scoped) · `logs` · `ses:SendEmail` (only if `send_email` enabled;
  scoped/verified) · `iam` for the runner's execution role (name-scoped — like TrafficPoppy, a
  Lambda platform can't be IAM-free).
- **STS packed-policy budget watch:** this is the set most likely to exceed the ~18-action DR5
  ceiling. If it does, use the broker's **managed-policy splitting** (the mechanism in the patent
  spec §4.8 / vm-poppy DR5) rather than trimming needed actions.
- Verify against the REAL `assessPermissionSet` (substring trap: `InvokeModel` etc.); all three
  attribution tags on every created resource; teardown hook + `npm run certify` before any listing.

## 9. Isolation & security

- **Agents never hold AWS credentials** (§4) — the single most important control.
- **Per-agent isolation enforced server-side** from the trusted dispatcher (never client-side):
  agent X's tools touch only agent X's S3 prefix / DynamoDB items. Mirrors MailPoppy's tenant
  isolation; treat as security-critical and test it.
- **Tool outputs are data, not instructions** — the runner never lets fetched content redefine the
  agent's system prompt or unlock tools.
- **Dashboard/API access** is Cognito-authorized (MailPoppy access-API pattern); server-side claims
  enforcement, per-agent authorization.
- **Destructive/outbound tools** (`send_email`, `http_request`) are constrained (verified/allowlisted
  targets) in MVP to deny an injected agent an open abuse vector.
- Transcripts + a per-run audit (which tools ran, tokens, cost) — nothing hidden (Resources tab
  parity).

## 10. UX

- **Agents list:** each agent as a card — name, trigger, last run, this-month spend vs cap, Run /
  Pause / kill. Empty state teaches: "An AI teammate that does one job well, in your own cloud."
- **Agent editor:** name, instructions (with a starter-template picker), model, tool checkboxes
  (each with a one-line risk note; `web_fetch` shows the injection caveat), trigger (on-demand /
  schedule), caps (pre-filled safe defaults), memory on/off.
- **Run view:** live transcript (model turns + tool calls + results), live cost, kill button;
  history of past runs with cost + outcome.
- **Approvals inbox:** every run "waiting for you" surfaces at the top of the dashboard
  (ApprovalsBar-style) with the agent's question + draft, and Approve / Deny / Reply — the
  free-tier counterpart of the mobile push flow.
- **Cost everywhere** (§7). Design kit `poppy.css`, `poppyAccent(...)`, plain language, type-to-confirm
  destructive actions, background+resume.

## 11. Reuse map (read-only references)

- `~/Projects/mailpoppy/apps/desktop/node-sidecar` — embedded-template CFN deploy pipeline;
  `apps/desktop` — the Cognito access-API + dashboard patterns (agents ≈ mailboxes; the access-API
  ≈ the agent API), tenant-isolation lesson.
- `~/Projects/vm-poppy` — repo layout, SEA build (+`--win32`), `tags.ts`, teardown/certify, CopyButton.
- `~/Projects/agentspoppy/AGENTS.md` — the contract (rating, teardown, tags, §9 costs).
- `~/Projects/traffic-poppy/DESIGN.md` — the honesty-section style + the Cognito team-access model
  (relevant if §15 team access is pursued).

## 12. MVP vs post-MVP

**MVP (P0–P3):** define agents · Bedrock (Claude) inference · the curated tool catalogue (§4) ·
on-demand + scheduled runs · per-agent memory · the full cost-guardrail suite (§7) · transcripts ·
Cognito dashboard · certify green.
**Post-MVP:** multi-agent orchestration (`invoke_agent`) · Fargate for long runs · webhook/event
triggers · owner-API-key models · cross-poppy tools · agent template library · browser team access.

## 13. Open questions for the founder

✅ **ALL ANSWERED / LOCKED — see §14.** (1 name · 2 inference · 3 execution · 4 tools · 5 premium ·
6 caps · 7 email scope · 8 price. Founder approved the recommendations for 3/4/6/7/8 on
2026-07-19 — "all good".)

## 14. Locked decisions (founder, 2026-07-19) — final for the implementation session

1. **Name: CrewPoppy** — family convention kept; "Mission Control for your AI crew" is the tagline.
   ("MyCrewPoppy" considered; "Crew" already implies ownership on a your-own-cloud platform.)
2. **Inference: Bedrock-first.** Tokens bill to the user's AWS; IAM auth (no API key to store or
   leak); region choice = data residency; corporate-friendly (no new vendor/DPA); auditable in
   their CloudTrail. Owner-supplied Anthropic/OpenAI key = post-MVP opt-in, clearly labelled as
   re-introducing an external vendor. The §15b marketing points are part of this decision.
3. **Monetization doctrine + premium:** never mark up infrastructure the user owns; the ONE paid
   extra lives outside the deployed infra → **CrewPoppy Mobile** (chat with your agents, run
   status, push notifications), built by **reusing the MailPoppy mobile codebase** (RN/Expo +
   Cognito + push + store runbooks), NOT the email metaphor. Honest security framing per §15:
   "private by architecture — no third party to sniff," never claim Signal-style E2EE (the agent
   runtime must read messages to act; that runtime is the user's own cloud). Missions + agent-API
   stay free-core post-MVP.
4. **Execution: Lambda-first.** `agent-runner` Lambda per run + `ask_user` suspend/resume
   checkpointing (§5); EventBridge for schedules; Fargate for long runs = post-MVP.
5. **MVP tool catalogue (§4):** `web_fetch`/`web_search`, `workspace_read`/`write`,
   `memory_read`/`write`, `send_email` (own verified addresses only), `http_request` (owner
   allowlist), and **`ask_user`** (human-in-the-loop). Native social connectors = post-MVP; the
   MVP social path is draft → `ask_user` → publish via allowlisted webhook (Buffer/Zapier/Make).
6. **Safe defaults:** per-agent monthly spend cap **$10**, max **8** iterations/run (both editable);
   never unlimited by default; global deployment ceiling on.
7. **`send_email` scope:** owner's verified address(es) only in v1 (anti-abuse). Broader recipients
   = a later, deliberate step.
8. **CrewPoppy Mobile price: $19.99/year** per deployment (above VPN-Poppy's $14.99; covers app
   store + push infra), via the AgentsPoppy first-party checkout.
9. **Persona identity + AI avatars (§3, §3c):** first/last name + freeform role; optional
   Bedrock-generated *synthetic* face (name-suggested, owner-controlled), watermarked "AI Avatar" +
   C2PA metadata (on by default, not removable); dual disclosure (image-provenance + interaction).
10. **Portability (§3b):** the "Crew Pack" export/import; teardown offers it first; a headline
    no-lock-in benefit.

## 15. Monetization — free core + ONE premium (LOCKED: the mobile app)

**Doctrine (founder, 2026-07-19):** never mark up the infrastructure — it's the user's own AWS.
Charge for ONE nice extra that lives *outside* the deployed infrastructure. Same structure as
MailPoppy mobile / True Reach / Shielded DNS.

**Free forever:** unlimited agents, Bedrock inference, the full tool catalogue, on-demand +
scheduled runs, memory, the complete cost-guardrail suite, transcripts, the desktop dashboard.
*(Multi-agent "Missions" and the external agent-API move to the free-core post-MVP backlog —
they are infrastructure capabilities, and the doctrine says we don't paywall those.)*

**Premium — LOCKED: CrewPoppy Mobile.** Talk to your crew from your phone — in BOTH directions:
- Chat-style conversations with each agent (send a task, the agent runs in YOUR AWS, replies),
  live run status, transcripts, cost meter, kill switch.
- **The killer flow: agent-initiated approvals.** When an agent calls `ask_user` ("I drafted this
  customer reply — approve?"), your phone gets a **push notification**; you read the draft and
  approve, deny, or answer in free text from wherever you are, and the run resumes. The free
  desktop dashboard has the same approvals inbox — mobile buys *immediacy* (your crew isn't stuck
  waiting until you're back at your desk).
- **Push privacy note:** push notifications transit Apple/Google (APNs/FCM) by necessity, so
  payloads stay **minimal and generic** ("Research-Agent needs your approval") — the actual
  content is fetched from the user's own backend when the app opens. The "no third party sees
  your content" claim survives push.
- **Build approach: a dedicated CrewPoppy app reusing the MailPoppy mobile CODEBASE** (React
  Native/Expo skeleton, Cognito SRP auth, API-Gateway client, push pipeline, store runbooks) —
  NOT the email metaphor. Chat-with-an-agent needs live status/streaming/kill, which email
  can't carry; and binding the purchase to a MailPoppy deployment would couple two products.
  *(An "email your agent" bridge — agents get an address on your MailPoppy domain, inbound mail
  triggers a run — is a lovely FREE cross-poppy integration for the post-MVP backlog instead.)*
- **Security posture (honest E2EE note):** the app talks ONLY to the user's own backend —
  phone → their API Gateway (TLS) → their Lambda → Bedrock in their account; Cognito-authed,
  encrypted at rest (their DynamoDB/S3), no vendor relay anywhere. Classic Signal-style E2EE is
  definitionally impossible here: the "other end" is the agent runtime itself, which MUST read
  the message to act on it — but that runtime is the user's own cloud, so the honest claim is
  stronger than most "E2EE" marketing: **there is no third party to sniff.** Marketing copy says
  "private by architecture — your chats never leave your own cloud," never "end-to-end encrypted."
  (Optional hardening, post-MVP: TLS certificate pinning in the app.)
- Sold per deployment as an AgentsPoppy first-party product (`kind=subscription`), like MailPoppy
  mobile. **Price: founder to confirm in §13** — anchor **$19.99/yr** (above VPN-Poppy's $14.99,
  below business-SaaS; covers app-store costs + push infrastructure).

### 15b. Marketing notes — the Bedrock story (bank these for the listing/site)

Why "agents in your own AWS via Bedrock" beats agent-SaaS — the seven sellable points:
1. **No API key exists at all** — access via IAM like everything else; the "leaked key = $4k of
   tokens" failure class is structurally impossible.
2. **Data residency** — pick the region; EU deployments keep prompt processing in the EU (the
   MailPoppy GDPR story, extended to AI).
3. **Zero new procurement** — corporates already have the AWS agreement/DPA/compliance stack;
   no new vendor review. ("Corporate-acceptable by construction.")
4. **Audit in YOUR logs** — every model call in CloudTrail + optional Bedrock invocation logging
   to their own S3; "watch what your agents do" includes the inference layer.
5. **One API, many models** — Claude default; Llama/Mistral/Nova in the same dropdown; no new
   vendor integration per model.
6. **Spend where the rest of their money is** — Cost Explorer/budgets/alarms apply; plus our own
   per-run meter and hard caps.
7. **Zero extra onboarding** — every AgentsPoppy user already has AWS; one-time Bedrock
   model-access click and they're live. No new account, no card, no signup.

## 16. Plan

- **P0 — walking skeleton:** scaffold (vm-poppy layout) → manifest + permission set verified against
  the real assessor (watch the packed-policy budget) → deploy an empty stack (DynamoDB + S3 + an
  empty runner Lambda + Bedrock permission) → teardown → `npm run certify` green → dev-install in
  AgentsPoppy.
- **P1 — one agent, one run:** agent def CRUD → `agent-runner` loop → Bedrock (Claude) call → **no
  tools yet** → transcript persisted → **live acceptance: define an agent, run it, read its answer,
  see the cost.** Guardrails (iterations/tokens/wall-clock/spend) enforced from day one.
- **P2 — the tool system:** the mediated dispatcher + the §4 catalogue, each per-agent scoped +
  unit-tested; the injection-safety posture; `web_fetch`/workspace/memory/email/webhook.
- **P3 — triggers, cost UX, dashboard polish:** EventBridge schedules · the full cost meter +
  estimates + kill switch · Cognito dashboard · run history · `--win32` build · pack + catalogue.
- **P4 — premium: CrewPoppy Mobile** — fork the MailPoppy mobile codebase (RN/Expo, Cognito SRP,
  push pipeline, store runbooks) into the agent-chat app; entitlement-gate it per deployment via
  the AgentsPoppy checkout; store submissions per the MailPoppy RUNBOOK lessons (org account!).
- Founder check-in at every phase gate; every live test torn down + verified clean (CLAUDE.md will
  encode this). **Bedrock note:** live tests need model access enabled in the founder's Bedrock
  console + real token spend — coordinate, and keep caps tiny during testing.

## 17. Status

**Design COMPLETE and founder-locked (2026-07-19).** All §13 decisions resolved in §14.
CLAUDE.md + README + LICENSE + .gitignore written; repo initialized. **Current phase: P0 —
walking skeleton.** Implementation delegated to a SEPARATE Claude Code session (handoff prompt
issued 2026-07-19) per the TrafficPoppy/VPN-Poppy model — this planning session does not
implement; coordinate via this DESIGN.md + commits.
