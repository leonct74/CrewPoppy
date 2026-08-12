# CrewPoppy — DESIGN

*Product name locked 2026-07-19: **CrewPoppy**. Tagline since 2026-07-30: **"the Crew HQ for your AI crew"** — the founder found another product using "Mission Control"; "Crew HQ" says an office of skilled employees, not a room of machines.*

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
- **The poppy screen IS the Crew HQ:** define agents, run them, watch cost, read transcripts.

### 2b. P0 implementation decisions (implementation session, 2026-07-20)

- **Identifiers:** app id `com.crewpoppy.desktop`; resource prefix **`CrewPoppy*`** everywhere
  (stack `CrewPoppyStack`, table `CrewPoppyData`, Lambda `CrewPoppyRunner`, role
  `CrewPoppyRunnerRole`) and lowercase `crewpoppy-*` for buckets (S3 constraint):
  `crewpoppy-workspace-<account>-<region>` (in-stack), `crewpoppy-deploy-<account>-<region>`
  (see below). `MissionControlAgents*` dropped — the product name is locked CrewPoppy (§14.1).
  Accent: `poppyAccent("com.crewpoppy.desktop")` = `#8fd0c6`.
- **Template authored as typed TypeScript, no cdk** (`infra/src/template.ts`, the TrafficPoppy
  pattern): the P0 footprint is 5 resources — small enough to author directly, and it removes
  the cdk dependency and the synth step. Same embedded-bundle contract as MailPoppy's generator.
- **Single-table design:** agent defs, memory, transcripts and run checkpoints are all items in
  `CrewPoppyData` (pk/sk). The TTL attribute (`expiresAt`) is declared from P0 so §5's expiring
  checkpoints/questions work from the moment the table exists.
- **Lambda code delivery = MailPoppy's content-addressed zip from day one.** The deterministic
  (STORED, fixed-mtime) zip of the runner is embedded in the sidecar and uploaded at deploy time
  to the **deploy bucket — the ONE resource outside the stack** — then injected via
  `LambdaCodeBucket/Key` template parameters. The bucket is created tagged (all three attribution
  tags, re-stamped on every deploy) and removed by the teardown hook. Chosen over an inline
  `ZipFile` stub so the walking skeleton walks P1's actual path.
- **In-stack log group** for the runner (`/aws/lambda/CrewPoppyRunner`): a Lambda-auto-created
  log group would be untagged → invisible to the sweep → orphaned after teardown. Its ARN is
  **constructed with `Fn::Sub`, never read back with `Fn::GetAtt`** — see the live-gate lesson
  below.
- **Collection-API trap (LIVE-GATE LESSON, 2026-07-26):** the first deploy that got past the
  packed-policy wall rolled back at `RunnerRole` with *"Unable to retrieve Arn attribute for
  AWS::Logs::LogGroup… Access denied for operation 'logs:DescribeLogGroups'"*. `Fn::GetAtt
  [RunnerLogGroup, Arn]` makes CloudFormation call `logs:DescribeLogGroups`, a **collection API
  that cannot be resource-scoped** — our least-privilege `/aws/lambda/CrewPoppy*` grant denied it.
  Fixed by constructing the ARN from the constant log-group name (no API call, no extra grant),
  and `logs:DescribeLogGroups` was **dropped from the manifest** (DR5 — the live run proved the
  log group both creates and deletes without it). Guarded by a template unit test; documented for
  every future poppy in AGENTS.md §3.
- **Teardown hook order:** empty workspace bucket → delete stack + wait for `DELETE_COMPLETE` →
  empty+delete deploy bucket. Idempotent; certification runs with host cleanup off, so the hook
  does all of it itself. The **Crew-Pack-first offer (§3b) lands with the export itself (P1+)**
  — the skeleton has no agent data to save; the placement is documented in `RemovePanel.tsx`.
- **§8 packed-policy finding (LIVE-GATE LESSON, 2026-07-20):** the broker's managed-policy
  splitting existed but only engaged when the session policy's PLAINTEXT exceeded ~2 KB. STS
  additionally enforces an invisible **packed** (compressed) budget that grows with action
  count — CrewPoppy's set (42 actions / 1690 plaintext chars) slipped under the plaintext
  threshold, went inline, and the first live deploy died at credential time with "Packed policy
  consumes 157% of allotted space". Fixed HOST-side (agentspoppy `b24a622`): the vend now
  catches the packed rejection and retries through the managed-policy route; documented for
  every future poppy in AGENTS.md §3. CrewPoppy's manifest needed no change — the set is
  legitimate and DR5 least-privilege still governs the *rating*. P0's manifest = 7 grants / 38 actions,
  every scope a concrete `CrewPoppy*`/`crewpoppy-*` ARN pattern → the real `assessPermissionSet`
  rates it **amber, zero unscoped findings**. The manifest carries **no bedrock grant until P1**
  (the sidecar doesn't call Bedrock at P0; the runner's in-stack role holds `InvokeModel*`,
  scoped to foundation-model/inference-profile ARNs); P1 adds `bedrock:ListFoundationModels`
  for the model dropdown (manifest change ⇒ normal re-approval).

### 2c. Bedrock model access — measured, not assumed (2026-07-26)

Tested live against the founder's account (675546221165 / eu-west-1). Four findings, three of
them counter to the documentation:

1. **Model IDs must be inference profiles, not bare foundation models.** `InvokeModel` on
   `anthropic.claude-haiku-4-5-20251001-v1:0` fails — *"on-demand throughput isn't supported;
   retry with an inference profile"*. The working form is the regional profile,
   `eu.anthropic.claude-haiku-4-5-20251001-v1:0`. **P1 must build model IDs as profiles.** The
   P0 runner role already grants `inference-profile/*` alongside `foundation-model/*`, so no
   permission change is needed.
2. **🪤 A first Bedrock call can succeed and then STOP working ~15 minutes later.** AWS
   auto-initiates the Marketplace subscription in the background on first invoke; during that
   window calls succeed *provisionally*. Our first test returned a real Claude reply; a re-test
   5 minutes later failed with *"Model use case details have not been submitted for this
   account."* **Never treat one successful Bedrock call as proof of access** — re-test after the
   settling window. This nearly sent P1 off on a false premise.
3. **The Anthropic first-time-use form is genuinely required**, and neither auto-enablement
   (Sept 2025) nor the `bedrock-mantle` endpoint avoids it. The docs' twice-stated carve-out
   ("does not apply to Anthropic models accessed through `bedrock-mantle`") did **not** hold:
   mantle authenticated fine over SigV4 but returned `403 permission_error — not available for
   this account`. Mantle stays a P2+ option (server-side tool use, Workspaces) — it costs
   Guardrails and cross-region inference, and does not dodge model access.
4. **Bedrock's auto-subscription needs Marketplace permissions ON THE CALLER — and this is
   what made Claude answer once and then stop.** A live run failed with *"Model access is
   denied due to IAM user or service role is not authorized to perform the required AWS
   Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)"*.
   Bedrock auto-subscribes a third-party model on first use **using the caller's own
   permissions**; without them the subscription never completes, calls pass only during
   the ~15-minute provisional window, and then fail. So the Anthropic form was one
   prerequisite and this is the other — finding #2 above was a symptom of this, not of
   propagation. Granted on the runner's **in-stack** role (`Subscribe` +
   `ViewSubscriptions`, deliberately NOT `Unsubscribe`), so the poppy's manifest and its
   rating are untouched. Marketplace actions take no resource scope; the only narrowing
   available is an `aws-marketplace:ProductId` condition, and those ids aren't knowable
   at build time.
5. **The blocked state is precisely detectable with ZERO extra permissions.** The runner's own
   `InvokeModel` returns `ResourceNotFoundException` with *"Model use case details have not been
   submitted"*. That string drives the setup card (§6) — no wildcard grant, no rating cost.
   `bedrock:GetFoundationModelAvailability` is *also* usable as a pre-check and **does** scope
   cleanly to `arn:aws:bedrock:*::foundation-model/*` (verified under a restricted session
   policy), unlike the use-case actions, which are account-level and cannot be scoped at all —
   `bedrock:PutUseCaseForModelAccess` on `*` rates **RED** with the real assessor, which is why
   the form is not submitted from inside the poppy (see §6).
6. **🪤 THE CATALOGUE OFFERED MODELS THE ENGINE CANNOT DRIVE (live failure, 2026-07-26).** An
   agent asked to send an email failed with *"The provided model identifier is invalid."* Nothing
   to do with email, and nothing to do with the account. The runner builds ONE wire format —
   Anthropic's (`anthropic_version` + content blocks) — and parses one, while the picker offered
   five models. Nova needs `{messages, inferenceConfig, toolConfig}`; Qwen and GPT-OSS are
   OpenAI-shaped. On top of that, `inferenceProfileFor` prefixes `eu.` unconditionally, and
   `eu.qwen…`/`eu.openai…` are not real profiles in eu-west-1 — which is the exact error string.
   **Worse, the agent form defaulted to the first model reporting `ready`**, so when the Claude
   rows lagged (finding #2), a new agent was silently created on a brain that could never work.
   **Fix:** every catalogue entry now declares its `wire`; `SUPPORTED_WIRES` lists what the runner
   actually implements; undrivable models are marked `supported: false`, are never `ready`, can
   never be the default, and appear greyed-out-but-visible in the picker with the honest reason
   ("CrewPoppy can't drive this one yet"). The runner turns the raw AWS string into a sentence
   naming the model and the fix. **Rule: a model joins `SUPPORTED_WIRES` in the same change as
   its adapter, never before.** Nova and the open-weight models return when those adapters are
   written — that is engine work, not a catalogue edit.

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
  items + S3 workspace). **Two halves, both required** (founder, 2026-07-31): the deliberate
  notes an agent writes with `memory_write` and looks up with `memory_read`, AND the plain
  recall of the recent conversation — its last exchanges are seeded into each new run. Notes
  alone were not "carries something from one run to the next", the promise the editor makes:
  an agent with Memory ticked still opened every message with "I don't have access to any
  previous messages" and re-asked for details given minutes earlier. Recall is bounded twice
  (6 exchanges, 8k chars, newest wins) because every carried word is re-billed on every later
  run — caps are mechanisms, §7. Clearing a chat therefore also trims what is carried, which
  is the founder's own mental model: tick it, be warned it costs more, tidy up to spend less.

Agent defs are **just data in your account** → fully portable, no lock-in. "Create unlimited
agents" is literal: they're rows, essentially free until run.

### 3a. Deleting ONE agent (founder request, 2026-07-26 — shipped)

The crew list needs a way to let an agent go, and "delete" has to mean it. The rule, mirroring the
teardown contract at a smaller scale:

- **Delete removes everything that was only ever that agent's:** its definition, its memory, its
  workspace files, its runs, their transcripts and any suspended checkpoint, and its spend
  counters. Removing the definition and leaving the memory would be the worst of both worlds —
  gone from the screen, still in the account — and memory is exactly where a customer's details
  or a held draft would sit.
- **Order matters: the definition goes LAST.** A failure part-way then leaves the agent visible
  and the delete retryable, rather than turning its data into orphans nothing lists.
- **The rest of the crew is untouched** — every key is derived from that one agent id.
- **A live run refuses the delete** ("Emma is working right now. Stop the run first"), because
  deleting the definition under a running Lambda leaves a run that can neither finish nor be
  found. A run that never reported back (§the staleness rule) does NOT block it, or a broken
  Lambda would make an agent permanently undeletable.
- **Ceremony:** two steps, the blast radius named in plain language, and type-the-agent's-name to
  arm the button — which also answers "which one am I deleting?" on a card among several. Cancel
  holds focus; the danger button is never the easy default.
- **Idempotent:** an agent already gone is a success, so a retry is safe.
- **Open (P3):** offer that agent's Crew Pack export in the dialog, the same way teardown will —
  today the dialog is honest that nothing comes back.

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

### 4c. Email, and approving capabilities as a SET (founder decisions, 2026-07-26 — shipped)

**The founder's framing:** *"an agent must send approval requests to a specific email address, but
it can send approved emails to other emails too"*, and *"when an agent is created, the user needs to
approve all capabilities allowed to an agent."*

**Two channels, because they carry different risk.**

| | Tool | Where it goes | Gate |
|---|---|---|---|
| To you | `email_owner` | The one address set for the install | none — it's your inbox |
| To anyone else | `send_email` | Wherever the agent proposes | **per-message approval** |

- **`email_owner` HAS NO RECIPIENT PARAMETER.** The schema itself is the control: the model cannot
  name an address, so "it can only ever reach you" is structural, not a promise. The address is
  install-level configuration (`config`/`owner-email`), stored only after SES confirms the account
  will actually send from it — address or its verified domain, because MailPoppy users verify domains.
- **`send_email` to a non-owner address never sends.** The dispatcher suspends the run and hands the
  exact message to the runner to store. **This is deliberately not left to the agent's instructions:**
  a prompt saying "always ask first" is text, and text is what an attacker gets to write. The refusal
  has to be structural so it holds for an agent that has been argued into anything.
- **Approval binds to the exact message.** The owner sees recipient, subject and body verbatim; the
  runner sends the STORED copy. A model that changes the address or the wording after the owner has
  stopped reading changes nothing that matters.
- **Approval is a button, never a sentiment.** `approved` is set only by pressing Approve. Typed
  words are never parsed for consent — "yes, but change the greeting" describes a *different*
  message, which is proposed and approved on its own. The UI says so, and disables Send-it while
  there's text in the reply box.
- **Hard ceiling:** `MAX_EMAILS_PER_DAY` per agent, claimed with a conditional atomic ADD *before*
  the send — a counter incremented afterwards is a tally, not a limit.
- **From-address:** an agent may have one of its own (`emailFrom`), checked against SES as it's
  typed; otherwise it sends from the owner's address. The display name is stripped of anything that
  could smuggle a second address into the From header. **CrewPoppy never creates mail identities** —
  that's MailPoppy's job (repo boundary).
- **IAM:** the runner's in-stack role gains `ses:SendEmail` on `identity/*` — send only, never
  `Create*`/`Verify*`, so it can use an address the owner proved but can never prove a new one. The
  manifest gains read-only `ses:GetEmailIdentity`. Rating unchanged: medium, no findings.
- **Sandbox note:** a fresh AWS account can only email verified recipients until AWS grants
  production access. The founder's account (675546221165) was granted it on 2026-06-04 via MailPoppy,
  so external send works there today — but a NEW user may hit the sandbox, and the UI should say so
  when a send fails for that reason.

**Capabilities are approved as a set.** The create/edit form groups tools the way an owner asks
(Memory · Files · Working with you · Reaching the outside world), and ends with "*Emma will be able
to: …*" immediately above the button that grants it. Nothing is on by default. Grouping is
presentation only — **enforcement stays per-tool in the dispatcher**; a group is never something an
agent holds. The same panel edits an existing agent, because a grant you can't revoke isn't a grant.

### 4d. PDFs and templates (founder decisions, 2026-07-28 — shipped)

*"PDFs are necessary — one of the most likely use cases is a sales offer sent to a customer,
or invoices in a specific template."*

- **`save_pdf` tool** (Files group): the agent writes the finished document in a Markdown
  subset (# headings, - bullets, | tables | with the |---| header convention, --- rules), and
  the runner typesets a real PDF into its workspace. **The renderer is hand-rolled — ~200
  deterministic lines, no library**: the JS PDF packages drag optional browser dependencies
  that fight the Lambda bundler, and offers/invoices are a bounded typesetting problem (same
  reasoning as the hand-authored CFN template, §2b). PDF 1.4, built-in Helvetica pair, WinAnsi
  encoding — **€ and £ work**, which invoices genuinely need. Deterministic output, so the
  content-addressed zip stays stable. Sample fixture: pdf.test.ts writes
  /tmp/crewpoppy-sample-invoice.pdf for eyeball checks.
- **Getting a PDF out:** the Files panel opens it in the owner's browser via a **five-minute
  pre-signed S3 URL** (`GET /agents/:id/file-link`) — their bucket, their browser, nothing
  routed through us. Text files keep the inline view + copy.
- **Templates:** the owner saves a text file INTO the agent's workspace from the Files panel
  ("Add a file…", `PUT /agents/:id/files`) — e.g. `invoice-template.md` — and the agent reads
  it with its own `workspace_read` and follows it. A template the agent can READ beats one
  pasted into instructions: it survives instruction edits, it's visible in the Files panel,
  and updating it doesn't touch the brief. Same traversal predicate and size limits as the
  agent's own writes — the owner is trusted, the string in the request is not.
- **Attachments — SHIPPED (same day):** both email tools take an optional `attach` — the name
  of a file in the agent's OWN workspace, validated with the same traversal predicate at
  propose time. Sending uses hand-rolled raw MIME (mime.ts, ~90 lines, same no-library
  reasoning; every part base64 so a fixed boundary is provably safe; headers flattened to one
  line so injection through a subject or filename is structurally impossible). **The approval
  card names the attachment AND opens it** via the same signed-link path — approving an
  attachment you haven't opened is not approval. Bytes are fetched at SEND time from the
  agent's prefix; a file that vanished between approval and send fails gracefully. A missing
  attachment never burns the day's send allowance. This completes the founder's core use case:
  ask by email → agent builds the offer PDF from the template → proposes the send → owner
  opens the exact PDF, approves → customer receives it attached.

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

### 4e. Web access — the tool §4 promised and P2 never shipped (founder, 2026-08-03: BUILD IT)

**Start with the discrepancy, because it is the point.** §4's MVP catalogue opens with
`web_fetch` / `web_search`, and P2's scope line names `web_fetch` explicitly. Neither exists.
The shipped catalogue is nine tools (`shared/src/tools.ts:20`) and **not one of them can retrieve
anything from outside the deployment** — no fetch, no search, no browse, no HTTP egress an agent
can direct. An agent's entire input is what the owner typed, what is in its own folder, and what
it wrote down last time. This was never decided; it fell out of P2 and nobody wrote it down. It is
not even in `COMING_CAPABILITIES`, so the app doesn't admit the gap to users either.

**The founder's decision and reasoning (2026-08-03), recorded because the risk framing is the
part that matters:**

> *"we need to give the users the choice to let an agent browse the web, otherwise their power and
> so use cases are minimal. Additionally there are much less risk to allow a CrewPoppy agent on the
> web rather than on the personal machine, because our agents can't access the user machine. Users
> are not stupid… will more likely provide urls and if the agents will find impossible to access
> that url, will likely communicate that to the user."*

The comparison is correct and load-bearing. The thing people fear about agents with web access is
an agent loose on *their computer* — files, browser sessions, credentials, other apps. A CrewPoppy
agent has none of that. It is a Lambda in the owner's AWS holding no AWS credentials of its own
(§4), reaching one DynamoDB table and one S3 prefix scoped to itself. Adding outbound HTTPS to that
does not widen its reach into anything the owner cares about; it widens what it can *read*.

**What this costs to build, which is less than it sounds:**
- **No new AWS permission, no rating change, no STS budget impact.** Outbound HTTPS is not an IAM
  action. The runner Lambda has no `VpcConfig` (verified in `infra/src/template.ts`), so it is
  already on the public internet with no NAT gateway to add — the manifest and the permission set
  are untouched. This is the rare feature with no §8 consequence at all.
- **Opt-in per agent, through the existing ceremony.** It is a capability in the §4c set the owner
  approves when creating or editing an agent — never a global switch, never on by default. An
  agent without it gets no tool spec for it at all (`specsFor`, `shared/src/tools.ts:325`).

**Decisions for the implementation session:**

1. **`web_fetch(url)` first; `web_search` second.** The founder's model is that people supply URLs,
   and that is also the version with no third-party dependency. `web_search` needs a search
   provider, a key the owner supplies and a per-query cost, so it is its own decision — but without
   it an agent can only go where it is pointed, which caps the "watch this for me" use cases. Ship
   fetch, then judge.
2. **Fetched bytes are DATA.** The posture already exists in code and in the system prompt, which
   names web pages specifically (`lambdas/src/agent-runner.ts:218`). Deliver the body inside an
   explicitly delimited block that says whose text it is and that it is untrusted.
3. **Block the private network.** Resolve the host and refuse non-public addresses — loopback,
   RFC1918, link-local (`169.254.0.0/16`), and the same check applied again after **every**
   redirect, since a public host can 302 to `127.0.0.1`. Lambda has no IMDS to steal, but this is
   four lines and closes the class.
4. **Every URL an agent fetches goes in the transcript.** This is the honest containment for the
   one risk the founder's framing does not cover: an agent that can read its own memory and files
   *and* fetch a URL can put what it read into a query string and hand it to a stranger's server.
   No allowlist survives contact with "browse the web", so the answer is visibility — the owner
   sees every address, in the same conversation they already read.
5. **Bound the cost.** Cap the body (truncate at ~200 KB), cap fetches per run, and let the existing
   per-run iteration/token/wall-clock limits and the monthly spend cap do the rest (§7). A page of
   HTML is a lot of tokens; this is a cost feature as much as a safety one.

**The one thing that must not be promised — say it before a user discovers it.** `web_fetch`
retrieves HTML. Google Flights, and most modern booking sites, are JavaScript applications: the
first response is an empty shell and the prices arrive later from XHR calls the fetch never makes.
So the founder's own example — *"the agent could simply browse google flights"* — **does not work
with `web_fetch` alone**, and it will not be the agent's fault. Do not put a flight example in the
marketing until that changes — the crewpoppy.com copy deliberately has none.

⚠️ **The paragraph above is WRONG, and §4f has the measurements.** Google serves a server-rendered
no-JavaScript fallback: a plain fetch of a Google Flights search URL returns 60,906 characters of
real itineraries and 29 fares, reproducibly. The founder's example works with `web_fetch` alone.
The paragraph is kept rather than deleted because the mistake is the point — it was written from
confident reasoning about how modern web apps behave, and one command disproved it. Read §4f.

**Schedule granularity, while we are here.** `every 4 hours` is not expressible: the kinds are
`hourly | daily | weekly` (`shared/src/schedule.ts:23`). Hourly covers the overnight-price case at
4× the runs. If arbitrary intervals are wanted, that is a small addition to the same enum and the
`isDue` maths — not a new mechanism.

### 4f. P6 — the plan for price search and comparison (MEASURED, 2026-08-03)

**The target, in the founder's words:** *"our target is to find a way to make possible for agents
to search for pricing and make comparison."*

**Measured before designed** — and the measurement overturned the reasoning in §4e, which is the
reason this section exists rather than a paragraph of confident prose. Reproduce it with
`python3 docs/web-fetch-probe.py`. Ordinary browser User-Agent, redirects followed, read-only GETs.
The metric is the honest one: money found in the text an extractor recovers after `<script>` and
`<style>` are stripped, because that stripped text is what the tool would hand the model.

| Target | HTTP | Text recovered | Prices in text |
|---|---|---|---|
| **Google Flights, real search URL** | 200 | **60,906 chars of results** | **29** ✅ |
| Ryanair booking page | 200 | **7 chars** | 0 |
| Kayak flight search | 200 | 2,384 chars (bot-check page) | 0 |
| tweakers.net Pricewatch | 200 | **22 chars** | 0 |
| coolblue.nl category | 200 | 17,484 chars | 0 |
| idealo.de price comparison | **403** | 268 chars | 0 |
| currys.co.uk category | **403** | 770 chars | 0 |
| Google Flights via r.jina.ai (rendering reader) | **403** | 16 chars | 0 |
| *Wikipedia, Hacker News (controls)* | 200 | full text | *n/a* |

**Google Flights works with a plain fetch, and it is the founder's exact use case.** Google serves
a **server-rendered no-JavaScript fallback** containing real itineraries for the requested route and
date — airline, airport, "Nonstop", CO2, and fares from €97 round trip, with departure dates
attached. Verified stable: four consecutive fetches returned byte-identical 60,906 chars and the
same 29 fares. At roughly **15k tokens per page** it is comfortably affordable inside a run and a
monthly cap.

⚠️ **Two earlier readings of this same URL were wrong, and both errors are instructive.** The first
counted prices in the *raw HTML* and found 22 — they were inside script blobs, not readable text.
The second stripped scripts correctly but caught a variant that returned 2,140 chars ending in
*"Loading results"*, and that became a confident claim in §4e that the use case was impossible. Only
repeated runs settled it. **Probe more than once before writing a conclusion into this document.**

**The rest of the field still fails, and the two failure modes are real:**

1. **The price is never in the HTML** — fetched by the page's own JavaScript after load. Ryanair
   returns seven characters of text. No parser recovers data that was never sent.
2. **The request is refused before that matters** — three 403s, including the rendering reader.
   Retail and comparison sites treat automated access as an attack, and a Lambda's datacentre IP is
   the easiest thing in the world to classify.

Neither is fixed by a nicer User-Agent or a better extractor. But note what the table actually says:
the failures cluster in **retail and airline-direct booking**, while the aggregator that publishes a
no-JS fallback works. The lesson is not "the web is closed" — it is **which targets to point people
at**, which is a §15l recipe decision as much as an engineering one.

**One trap to avoid on the way past.** Google Flights' raw payload also carries fares inside
`AF_initDataCallback` script blobs, in 1.9 MB of minified JavaScript — roughly half a million tokens
if handed to the model whole. The readable fallback above is 15k. Extract text and cap the body
(§4e); never pass raw HTML through, or one fetch spends the month's budget.

#### The plan: split P6, because these are different problems

**P6a — `web_fetch`, the general web.** Build it first, exactly as §4e specifies. It is small, it
changes no permission, it adds no infrastructure, and it unlocks a genuinely large class:
documentation, reference and government pages, articles, RSS, any JSON API the owner points it at —
**and, on the evidence above, the flight-price watch that started this whole thread.** That last
one is the flagship demo and it needs no key, no provider and no third party. Build P6a, point a
scheduled agent at a Google Flights URL, and the founder's use case runs end to end on shipped
parts.

⚠️ **It rests on a no-JS fallback Google is under no obligation to keep.** Do not hard-code
anything about the page shape; treat it as one URL among many, keep the probe in `docs/` current,
and make the agent's failure message clear enough that the day it stops working the owner is told
rather than quietly given nothing.

One UI consequence falls straight out of the measurements: when a fetch succeeds but yields almost
no text, the tool must return a **specific** failure — *"this page builds itself in a browser; I
could not read it"* — and a 403 must say *"this site refused an automated request."* Not an empty
string the model then hallucinates around. Given that, the agent reports the problem to the owner,
which is exactly the behaviour the founder predicted it would have.

**P6b — the web provider: one setting that decides how far an agent can reach.** Needed for the
targets P6a cannot reach — retail comparison, airline-direct booking, anything behind a 403 — and
*not* for flights via the aggregator. That reordering matters: P6b is no longer on the critical path
to a working demo, so it can be judged on real demand instead of built on faith. The agent still
sees one tool with one signature. The deployment carries a provider setting:

- **`direct`** — the plain fetch of P6a. Free, no key, no third party. The default.
- **A rendering / anti-bot API** — owner-supplied key (ScrapingBee, Zyte, Firecrawl, Bright Data,
  Oxylabs). A real browser plus residential egress, which is the only thing that answers *both*
  failure modes at once. This is what commercial price monitoring actually runs on.
- **A search API** — SerpApi and its equivalents expose **Google Flights and Google Shopping as
  structured JSON endpoints**. This is the shortest honest path to the founder's literal example,
  and it returns clean data rather than a page to be parsed and hoped over.
- **Later, domain APIs** — Amadeus / Duffel / Kiwi for flights, eBay Browse for retail. Structured
  and legitimate; each is its own integration, so add them only where the demand is proven.

**Why an adapter rather than picking one now:** every option above costs a key and a bill, and which
one is right depends on the owner's country and target sites. One seam, several backends, and the
agent-facing tool never changes shape as they are added.

**The comparison half is already built, and this is the good news.** Once text or JSON is in the
loop the model compares it; `memory_write` remembers last week's number; the hourly schedule re-runs
it overnight, which is where the founder observed prices move; `save_pdf` produces the table and
`send_email` delivers it behind the approval gate. All shipped, all tested. **Every unsolved part
of this feature is retrieval** — which makes P6b the whole job rather than half of it.

#### Three things to decide before P6b is built

1. **Who pays the provider.** A key is a bill that is not AWS. crewpoppy.com says *"You pay AWS for
   what your agents actually use. Nothing to us"* — that stays true, but *"nothing to anyone else"*
   stops being. Same class of copy change as §15l's paid packs, and it should be made in the same
   breath.
2. **Data leaves the account.** With a provider, the URL an agent visits is handed to a third party.
   It is a public URL rather than the owner's documents, but §9 and the privacy policy both say work
   stays in the owner's AWS. That needs one honest sentence in each, and the provider setting should
   say it at the moment of choosing — not in a policy nobody opens.
3. **Terms of service.** Scraping Google Flights breaches Google's terms; using a provider does not
   change that, it only makes it work. SerpApi, Amadeus and Duffel are the routes that are both
   technically and contractually sound. Default the documentation to those, and never ship a §15l
   recipe pointed at a site whose terms forbid it — a recipe is us telling someone to do it.

#### What building it actually taught (P6a implemented, 2026-08-03)

Three things the plan above did not know, all found by pointing the finished tool at the
real page rather than at a test double:

1. **A self-identifying User-Agent is worse than a browser one — not politer.** The first
   implementation sent `CrewPoppy/1.0 (+https://crewpoppy.com/)`, the conventional courtesy.
   Google answered it with `/travel/flights/unsupported`: an "unsupported browser" page, 629
   characters, no fares, HTTP 200. The identical request with an ordinary Chrome string
   reached the real results. Self-identifying does not get a fetch politely declined — it
   gets it silently handed a worse page. `lambdas/src/web.ts` now sends a browser string and
   the comment above the constant states the boundary that replaces it: one request, no
   retries, no proxy rotation, no CAPTCHA solving, and a 403 reported as a refusal.
2. **The EU consent bounce is why the early probes looked flaky.** From the Netherlands the
   URL redirects to `consent.google.com` and back before reaching results — three hops. The
   probe's `curl -L` followed them silently; the "Loading results" and 2,140-character
   variants seen earlier were this chain ending somewhere unhelpful. The manual,
   re-checked-per-hop redirect handling §4e specified for SSRF turns out to be load-bearing
   for the feature working at all, and every hop lands in the transcript.
3. **The 40,000-character cap is exactly right, and it truncates.** Live result: 40,037
   characters returned (the extra being the truncation notice), fares €97 · €100 · €101 ·
   €102 · €121 · €126 · €135 · €141 · €143, four runs out of four. The whole answer fits.

**Status: P6a is built** — `lambdas/src/web.ts` (fetch, address vetting, extraction),
`web_fetch` in the shared catalogue, the dispatcher case, 24 new tests. Manifest re-verified
against the real assessor: **still `medium`, no new action**, as predicted. Not yet live-run
inside a deployment; that is the founder gate.

#### ⛔ The flight recipe is WITHDRAWN, and the reason corrects §4f above (2026-08-11)

Everything above about Google Flights being readable was measured **from a laptop**. From
the founder's Lambda the same URL degraded over days: the first live run returned a €90
fare, later runs returned the loading shell, and by the third day it was **403**. The
laptop returned nine fares throughout, 8 attempts out of 8. The variable is the EGRESS —
Google progressively blocks a datacentre address that keeps asking, and Lambda leaves from
an AWS range.

**So the headline finding of §4f is only true for residential egress.** `web_fetch` reaching
a page from this machine says nothing about the same fetch from the deployment, and three
releases (0.6.0, 0.6.1, 0.6.2) were spent fixing the wrong layer — a parser threshold, then
a missing date — because the laptop kept confirming a world the Lambda did not live in.
Both fixes were real and stay; the method was wrong. **Verify a web target from a real
deployment, repeatedly, over days, before any recipe depends on it.**

What survives: `web_fetch` itself, and the sites that do not defend against automation —
reference, documentation, publishers, JSON APIs. What does not: any recipe promising a
specific defended site's data.

**P6b is back ON the critical path**, exactly reversing the note above. The flight watcher
needs a flight API with an owner-supplied key (Amadeus Self-Service free tier, Duffel,
Kiwi) rather than a scraped page. That is the honest route, and setting it aside was a
decision made on laptop evidence.

**Recommended order:** **P6a now, and stop there until it has been used.** It delivers the flight
watch by itself, which was the thing worth proving. Then re-run the probe against whatever people
actually ask for, and build the P6b seam with **one** backend only when a real target needs it —
chosen by measurement, not by catalogue. The probe is the template: measure, then decide, and put
the numbers in this document rather than the reasoning that preceded them.

### 4g. P8 — Vision: agents that can look at an image (founder, 2026-08-11: PLAN)

**The use case that asked for it:** *"an agent that takes copies of receipts and saves them
in the right folder… but it might require an OCR."* It does not require an OCR, and that is
the finding worth recording: three models in `shared/src/models.ts` are already flagged
`vision: true`, and a vision model reads a photographed receipt — merchant, date, total,
VAT — better than classical OCR, because it understands layout instead of lifting
characters. What is missing is purely plumbing: **no image has ever been able to reach the
model.** `workspace_read` does `transformToString()` (a JPEG becomes mojibake) and the
Bedrock request builder emits text-only content blocks.

**The design, kept to the §4 shape:**

- **One new tool: `read_image`** (owner label: "Look at photos and scans", Files group).
  Reads ONE image from the agent's OWN workspace prefix — same scoping rule as every file
  tool, path validated by `isSafeRelativePath`, prefix built from the runner's agentId.
- **The dispatcher gains one optional result field** (`image?: { mediaType, base64 }`)
  and `loop.ts` renders it as an image content block inside the tool_result. Everything
  else about the loop is unchanged.
- **Non-vision models get a sentence, not a failure**: "your model cannot see images — ask
  your owner to switch you to one that can." The editor already knows which models see
  (`vision: true`) and should say so beside the model picker when this tool is ticked.
- **Bounds**: jpeg/png/webp/gif only (sniffed, not just extension); reject over ~4.5 MB
  with a message telling the owner to re-photograph rather than silently failing (Bedrock's
  request ceiling; the Lambda has no image library to downscale with, on purpose — no new
  dependencies in the runner).
- **No new AWS permission**: S3 GetObject on the own-prefix and Bedrock InvokeModel are
  both already granted. No manifest change, no rating change, no STS budget cost.
- **Cost honesty**: an image is roughly 1–1.6k tokens on Claude-class models. Cheap per
  receipt; the per-run cap and monthly cap already bound it.

**What it unlocks beyond receipts**: photographed invoices and contracts, screenshots,
whiteboard photos, the phone camera as an input device generally — the phone app already
uploads images to the workspace today, they just land unreadable.

**The lesson that gates it (this week's, §4f):** it ships only after being run from a REAL
deployment — a receipt photographed on the founder's phone, uploaded from the app, read by
the agent, filed and totalled — not after a unit test passes. There is no external service
to blame here, but the rule is now general.

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

### 5b. Agents that run themselves — ONE ticker, not a rule per agent (P3, 2026-07-27)

An implementation decision, recorded here per CLAUDE.md.

**The obvious design is one EventBridge rule per agent, and it's the wrong one.** It makes the
sidecar create and delete AWS resources every time somebody edits a schedule, which:
- needs `events:PutRule`/`PutTargets` **plus `lambda:AddPermission` at runtime** — ~10 more
  manifest actions against the STS packed-policy budget that already bit us once (§2b);
- leaves per-agent resources for the sweep to find at teardown;
- puts a failure mode between "I set a schedule" and "it saved".

**So the stack owns ONE rule** (`CrewPoppyTick`, `rate(5 minutes)`) that pokes the runner, and a
schedule is **data on the agent**, exactly like its tools and its caps — free to change, nothing
to provision, nothing to leak, and it disappears when the agent does. The tick costs one short
Lambda invocation every five minutes, comfortably inside the free tier, and it buys back the
"$0 when idle" promise everywhere else.

- **Plain language, never cron.** "Every day at 09:00" is checkable at a glance; `0 9 * * *` is
  something people get wrong and discover a week later. Hourly / daily / weekly, and the minute
  picker only offers multiples of the tick — offering 09:07 would promise precision we lack.
- **The owner's clock.** An IANA zone is stored, so 09:00 stays 09:00 across a daylight-saving
  change (tested both sides of one).
- **Due is a WINDOW, not an equality.** EventBridge fires "within the minute", never on the
  second; testing for an exact wall-clock reading would skip runs silently, forever.
- **Idempotent by SLOT.** The run id is `slotIdFor(agent, slot)` — a pure function of the agent
  and the time slot, never of "now" (CLAUDE.md gotcha #3) — written with
  `attribute_not_exists(sk)`. A duplicated or retried tick cannot fork a second run.
- **Never stacks up.** An agent already running, or waiting on the owner's answer, is skipped.
- **One agent's failure is its own** — a broken schedule can't stop the rest of the crew.
- **🪤 LIVE FAILURE (2026-07-27): the runner could not invoke ITSELF.** The ticker hands each
  due agent its own invocation, but the runner's in-stack role had no `lambda:InvokeFunction`.
  The tick found the due agent, wrote its run row, then failed at the invoke — the run sat at
  "running" until the staleness rule marked it failed, and **nothing on screen said
  "permission"**. Fixed with an `InvokeSelf` statement scoped to exactly one function, its own,
  ARN constructed not read back. Guarded by a test asserting the role holds that single lambda
  action and no other.
- **🪤 LIVE FAILURE (2026-07-27, same evening): `rate(5 minutes)` is NOT clock-aligned.** A
  rate expression counts from the moment the rule was created, so its ticks land on an
  arbitrary offset — :02/:07/:12… or :06/:11/:16. In the second case a schedule set for 21:00
  is **never sampled**: the ticker doesn't look during the window, so the agent never runs, and
  which behaviour you get depends on the minute the stack happened to be deployed. That is the
  worst kind of bug — silent, intermittent across installs, and impossible to tell apart from
  "the schedule is wrong". Fixed with `cron(0/5 * * * ? *)`, which is aligned to the clock, so
  ticks are always :00/:05/:10 — exactly the minutes `sanitiseSchedule` snaps to.
- **🪤 THE ONE THAT COST THE MOST: "update available" compared the TEMPLATE only.** The
  template and the agent-runner code are two independently versioned artifacts, but `getStatus`
  compared only `crewpoppy:templateKey`. So a **Lambda-only change was invisible** — the app
  told the founder there was nothing to apply while the deployed runner was two changes behind.
  Worst of all, the change it was hiding was the ticker's own heartbeat, so the diagnostic we
  were both reading ("AWS has never woken CrewPoppy") was produced by code that had **never been
  deployed**. It was true and meaningless at the same time. Fixed: the stack now also carries
  `crewpoppy:lambdaCodeKey`, and EITHER half being stale — or the tag being absent, because
  unknown is not the same as current — offers the update. Both versions are shown in Technical
  details at all times, not only when an update is pending. Same family as CLAUDE.md gotcha #1
  (a stale sidecar masking Lambda changes), one level further out.
- **The heartbeat is written FIRST, before any agent is started.** Written last, a tick that
  woke and then threw was indistinguishable from a tick that never woke — which is precisely the
  confusion it exists to remove. A second write follows only when something actually started.
- **🪤 THE ROOT CAUSE OF THE SILENT WEEK-END (found 2026-07-28): a corpse row blocked every
  schedule.** Saturday's first ticks ran before `InvokeSelf` existed: each wrote its run row and
  then FAILED at the invoke, leaving the row at "running" forever. The ticker's no-stacking
  check read that status RAW — only the sidecar applied the staleness rule — so every later
  tick counted the agent due and skipped it as "busy". The heartbeat said "1 due" while nothing
  ever started, and the owner stared at a silent card. **Rule: any code that treats "running"
  as meaningful MUST apply the shared staleness predicate** (`neverReportedBack`, now in
  shared/guardrails.ts, used by both the sidecar and the ticker — they judged differently once,
  and it cost a day). A run genuinely `waiting` on the owner still blocks: that's deliberate.
  The ticker now has regression tests, including this exact corpse.
- **🪤 And the clock was unverifiable.** The founder set 20:40 and had no way to tell whether
  that meant 20:40 where they were: the zone was captured from the browser and only shown, never
  editable, and nothing said when the next run would be. Fixed with a timezone picker **and** a
  `POST /schedule-preview` that answers "next run at…" using the TICKER'S OWN CODE. Deliberately
  a round-trip rather than arithmetic in the frontend: a second implementation could answer
  confidently and wrongly, which is the one thing a schedule preview must never do. The agent
  card shows the same computed time.
- **🪤 Both ARNs are built with `Fn::Sub`, never `Fn::GetAtt`** — the §2b collection-API trap
  repeating; a GetAtt makes CloudFormation call a describe API under our least-privilege grants.

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

### 7b. The cost meter — our own counters, never the pricing API (decided 2026-07-28)

The §2d conflict is resolved by not taking the pricing grant at all. `pricing:GetProducts`
cannot be resource-scoped, so it would cost the manifest's "no findings" verdict — for numbers
our own spend counters already hold. The meter is therefore:

- **One always-current line above the crew** — "This month: ≈ $X across N agents · combined
  limits $Y" — computed from the SAME per-agent spend rows the caps enforce, so the number the
  user sees and the number that stops a run can never differ.
- **The caveat is visible, not tooltipped:** models without a published rate (all Claude,
  today) are counted at the safety ceiling — high on purpose, so a limit stops early, never
  late — and the AWS bill is named as the final word. A meter that looks like an invoice but
  isn't one is worse than no meter.
- Real per-token rates for Claude arrive only from a VERIFIED source (a measured Price List
  row, or a founder-confirmed figure) — never hardcoded from memory. `costFor` returning
  `usd: undefined` for unknown rates stays the rule: no guessed numbers, anywhere.
- Fixed in the same change: the App-level "$0.00 — no agents exist yet" banner was static and
  kept saying so forever, spend and all. The money line lives in CrewCard, which knows the crew.

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

### 10b. The run view is a CHAT (founder note, 2026-07-27)

*"The human has to learn a whole new chat visual pattern, so it isn't really friendly"* — and
with several agents on one page, unbounded trails made it hard to tell whose was whose.

- **A run is a conversation, so it looks like one.** Your words right, the agent's left, names
  above each, `Enter` sends and `Shift+Enter` adds a line. Nothing here is a pattern anyone has
  to learn.
- **Tool steps are centred, monospaced and quiet** — visible always (§9 leaves nothing hidden),
  but they are machinery, not speech, so they never wear a speech bubble.
- **The log is bounded and scrolls inside its own card.** That's the multi-agent fix: an
  unbounded transcript pushes the next agent's card off screen, which is precisely what made
  orientation hard.
- **Your message appears the instant you send it**, before the first poll — a chat box that
  swallows what you typed for two seconds reads as broken whatever it's doing.
- **The composer locks while a run is waiting on you**, so a pending approval can't be
  accidentally abandoned by starting a second run in the same box.
- **An approval is NOT a chat message.** It stays a distinct card below the conversation, with
  the proposed email laid out as To / Subject / body. A decision that sends mail to a stranger
  should not look like another bubble in a stream.

### 10c. Say the "no"s out loud (founder-found, 2026-07-27)

The founder asked an agent whether it had received any email; it correctly answered that it has
no inbox. **The agent was right and the screen was wrong** — a capability list that shows only
what IS possible reads as a complete account of what an agent can do. `COMING_CAPABILITIES` now
puts the expected-but-absent abilities in the list, greyed out, with the real blocker.
These are **not tools** and never reach the dispatcher. The wording must name the actual
obstacle: "needs MailPoppy" would imply installing MailPoppy switches reading on, and it does
not — mail bodies are sealed to the recipient's key, and that work is MailPoppy-side (§15c).

### 10d. Panels earn their size by the user's CURRENT task (founder note, 2026-07-28)

The models panel dominated the screen long after it had done its job, and its primary
button competed with Run/Approve/Stop. The rule now: **a panel's prominence follows the
user's current task, not the panel's own importance.**

- **First run (no agents):** the models panel is the task — full detail, real button.
- **Crew exists:** it collapses to one line ("Models · N ready · AWS model page ↗ · Show"),
  with the console link demoted to a ghost link — still there, never competing. One click
  expands; the choice is remembered for the session.
- Same logic already applies elsewhere: the ticker line only appears when something is
  scheduled, the email-address field only when an email tool is chosen.

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

1. **Name: CrewPoppy** — family convention kept; tagline now "the Crew HQ for your AI crew" (renamed from "Mission Control" 2026-07-30 — collision with another product).
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

> **PROPOSED REVISION — Lite / PRO (founder, 2026-08-01, NOT YET DECIDED).** See §15k. The
> founder's objection to the locked model is sound: notifications alone are a weak paywall
> because in the commonest case you are already in the chat waiting, so the buzz tells you
> nothing you can't see. §15k records the proposal, what it fixes, and the two problems it
> must answer before it replaces this section.

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
- **Monetisation shape — DECIDED 2026-07-30 (founder: "this is the only option"), replacing
  the app-as-paywall assumption above.** The mobile app itself is **FREE and genuinely
  functional**: log in, chat with agents, approve — everything works when you open it.
  **Paid: the push channel** — "your crew can reach YOU": instant notifications the moment an
  agent needs an approval or finishes work (live run streaming may join this tier if the offer
  needs thickening). Why this line: (1) the push relay is the ONE component that can never
  live in the user's AWS (APNs/FCM deliver only through the publisher's keys), so charging for
  it never violates "never charge for what the user owns"; (2) entitlement enforced on OUR
  relay, server-side — a public repo can't unlock it (the MailPoppy domain-unlock lesson, done
  without moving any user data through our servers); (3) Apple-proof: the free app is fully
  functional when opened (a store rule even REQUIRES apps to work without push), and the
  subscription is buyable BOTH as in-app purchase (Apple's 15% small-business cut, priced in)
  AND via AgentsPoppy — same entitlement. Considered and REJECTED: hosting the approval API
  outside the user's AWS to make approvals lockable — it would put the most sensitive content
  (the full proposed email) on our servers, make us a single point of failure for every
  running crew, and paywall a safety mechanism. Generalised for all poppy developers in
  agentspoppy docs/MARKETPLACE.md §3 ("Designing a mobile companion that survives the app
  stores").
- **Scope rule (founder discussion, 2026-07-29): the phone USES the crew, only the desktop
  EXPANDS its powers.** v1 mobile = task, approve, watch, kill. Creating agents stays on the
  desktop: creation is a granting ceremony (capabilities, caps, addresses, templates) that
  deserves a desk, and a phone left on a table must never be able to mint a new agent or
  widen one's reach. Pocket-sized later additions: pause, nudge a spend cap, clone an
  existing agent (reusing a deliberate grant, not composing a new one).
- **Voice input (founder, 2026-07-29): dictate tasks, hold-to-talk.** Day one comes free —
  the keyboard mic dictates into the chat field, on-device. A built-in button follows the
  doctrine: audio NEVER touches our servers — on-device speech recognition first, Amazon
  Transcribe in the USER'S account as the upgrade path. No voice-assistant mode (no TTS
  replies, no wake word) — the value is firing off a task while walking, dictation covers it.
- **Store positioning (founder, 2026-07-29): never call it a "chat app".** The interaction is
  ONLY with the user's own agents in their own deployment — no user-to-user messaging, no
  public AI chatbot, nothing without a login to your own cloud. List it as a *companion app to
  your own AWS deployment* (the AWS-Console-app category). That framing also answers Apple's
  AI-content-moderation questions with the strongest possible fact: single user, own agents,
  own data, nothing generated for strangers. The store risk that actually needs managing is
  the PAYMENT rule (subscription sold outside Apple) — MailPoppy mobile's store runbooks are
  the reference for that.

### 15c. The MailPoppy bridge — investigated 2026-07-26, and why it's MailPoppy-side work

The "agents read your incoming mail" use case (founder's sales-enquiry example). Read
MailPoppy's actual surface rather than assuming; three findings, in order of how much
they matter:

1. **Message bodies are ENCRYPTED AT REST BY DEFAULT** — sealed to the recipient's
   libsodium public key, unwrapped only by a password-derived private key that never
   leaves the client. A sibling app reading MailPoppy's bucket gets **ciphertext**. This
   isn't an obstacle to route around; it's MailPoppy's core promise working. Only
   `subject/from/to/date/threadId` stay cleartext in DynamoDB — too thin to draft a reply
   from. **Any inbound bridge must therefore hand the message over INSIDE
   `inbound-processor`, before/independently of sealing, to a destination the user
   configured** — never by granting CrewPoppy read access to stored mail.
2. **There is no event to subscribe to.** `NotificationsTopicArn` is a *bounce/complaint*
   topic; nothing publishes to it, and it isn't even wired to SES. No DynamoDB stream, no
   S3 notification, no EventBridge rule beyond the janitor. The only inbound signal is an
   Expo push to mobile devices. MailPoppy's own DESIGN Phase 7.1 names the missing
   primitive: *"the inbound-processor emits a 'new mail' event → EventBridge/SNS"*.
3. **No machine auth.** The access-api is a Cognito **public** client, SRP only — no
   client-credentials, no resource server, no API keys (Phase 7.2, unbuilt). A daemon
   cannot authenticate; it would need a human's password.

**Rule that governs the design (AGENTS.md §3):** a poppy may only touch resources IT
created. CrewPoppy must never hold grants on `mailpoppy*` / `MailpoppyMailStack-*`.
⚠️ **The assessor cannot catch this** — such a grant is a concrete ARN pattern, so it
rates amber/`scoped:true` with ZERO findings while flagrantly breaking the invariant.
The rating checks how NARROW a grant is, never WHOSE resources it names. Worth fixing
platform-side; CrewPoppy is the first poppy where the shortcut would be tempting.

**Conclusion:** the bridge is real and both products' principles align (mail never leaves
the owner's account), but the work is **MailPoppy-side first** — Phase 7.1's event
emission — and the handoff must be initiated by the poppy that owns the data, into an
endpoint CrewPoppy owns, with the user explicitly connecting the two. Sequenced AFTER
P2, which delivers `send_email` + `ask_user` — two of the three pieces that use case
needs, and the ones that make agents able to act at all.

### 15d. Agents emailing YOU — the approval channel (founder request, 2026-07-26)

Decomposed, because the three things sound like one feature and cost wildly different amounts:

1. **Agent → owner email (approvals, reports). NO MailPoppy needed, and none of §15c's
   blockers apply.** This is `send_email` from the §14.5 catalogue: SES `SendEmail` from the
   runner role to the owner's own verified address(es) (§14.7's anti-abuse scope). Outbound
   never touches stored mail, so encryption-at-rest, the missing event and the absent machine
   auth are all irrelevant. **P2 work, already planned.** Sender identity: let the owner name
   the address and let SES reject an unverified one with a clear message, rather than adding a
   `ListIdentities`-style collection grant we'd have to widen the manifest for (the pattern the
   log-group and pricing traps taught us).
2. **Owner replies BY EMAIL → resumes the run.** This is the expensive one: it needs inbound,
   i.e. every §15c blocker. Not a prerequisite for approvals — the agent can email *"Emma needs
   your approval"* with the draft, and the decision happens in the dashboard (or, post-MVP, a
   phone). Email as the NOTIFICATION channel; the dashboard as the DECISION surface.
3. **Chat with your agents — belongs in CrewPoppy Mobile, not MailPoppy.** §14.3/§15 already
   settled this deliberately: chat needs live run status, streaming and a kill switch, *"which
   email can't carry"*, and binding it to a MailPoppy deployment *"would couple two products"*.
   Building agent chat inside MailPoppy would duplicate the locked premium and re-open a
   decision made for good reasons. If the goal is "talk to my crew away from my desk", the
   answer is the mobile app (§15), not a second chat surface.

**Recommendation:** ship (1) with `ask_user` in P2 — that delivers the approval loop end to end
minus the email *reply*, with no cross-poppy work and no new blockers. Revisit (2) only if
replying from the inbox proves to be the thing people actually miss.

**UI requirement (founder, 2026-07-26) — MailPoppy is required for READING mail, and only
that.** The two features must never be conflated in the interface:
- **Mobile approval needs nothing else.** SES sends the request, the phone approves via the
  §15e link. Do NOT gate it behind installing another poppy.
- **Agents reading incoming mail requires MailPoppy**, so the tool's entry in the agent editor
  is disabled with a plain line — *"Reading email needs MailPoppy, which gives this account its
  own mail domain"* — and a link to install it (`host:openExternal`, or the host's own poppy
  catalogue if it exposes one).
- ⚠️ **Necessary, not sufficient.** Installing MailPoppy alone does not make reading work: the
  bodies are sealed at rest (§15c), so the handoff has to happen inside MailPoppy's
  `inbound-processor` before sealing. Until that bridge exists the UI must say the feature is
  coming, never imply that installing MailPoppy switches it on — promising a capability that
  then silently does nothing is the §4b failure this product is supposed to avoid.

### 15e. Approving from a phone (founder decision, 2026-07-26)

Free, and no mobile app required. `ask_user` emails the owner; the email carries a link to a
**Lambda Function URL** in their own account (TrafficPoppy's mechanism, so a small template
addition rather than new architecture).

- **Auth is a capability, not a session.** A high-entropy single-use token, unique path per
  request (`/a/<token>` — the hostname is necessarily fixed; minting one per approval would mean
  creating AWS resources per request). No valid token ⇒ the endpoint reveals nothing: no draft,
  no agent name, no confirmation that anything exists.
- **🪤 GET must only RENDER; approval is a POST from that page.** Mail scanners and clients
  prefetch links — approving on GET would let Outlook's safe-links or a Gmail proxy approve
  every request before the owner ever saw it. The two-step also satisfies AGENTS.md §4.
- **Two clocks.** The LINK expires after **24 h**; the REQUEST keeps waiting in the dashboard
  until approved there, or until the run expires gracefully (§5). Missing the window costs the
  convenience, never the work. ⚠️ Check the timestamp in code — DynamoDB TTL deletion can lag
  up to 48 h, so it is housekeeping, never the security control.
- Never log the token path; compare tokens in constant time.
- **Honest limit:** anyone who can read that mailbox can approve — the password-reset trust
  model. A stronger login arrives later via the MailPoppy client / CrewPoppy Mobile.
- Does not undercut the §15 premium: mobile still owns push immediacy, conversation, live run
  status and the kill switch.

### 15f. Approve by email — SHIPPED (2026-07-28), and what stays MailPoppy-side

The founder's ask: *"the user can send an email to the agent asking to create the offer and
the agent asks for authorisation by email and sends it."* Split honestly in two:

**The approve-by-email half is live.** When any run pauses — a question or a proposed send —
the runner emails the owner the question, the EXACT message (to/subject/body/attachment name),
and a link. Implementation of the §15e contract:

- **`CrewPoppyApproval`** — a separate Lambda behind a Function URL, CrewPoppy's ONLY
  internet-facing piece, with a MINIMAL role: table Get/Put/Update (no Query — it can read rows
  it can name, never enumerate) + invoke-runner. No Bedrock, no SES, no S3. A stranger who
  finds the URL has found a door with almost nothing behind it. Guarded by a template test.
- **Unique address per request** (`/a/<runId>/<64-hex-token>`); the token lives only in the
  emailed link, stored as a SHA-256 hash, compared with timingSafeEqual; **24 h expiry** on the
  link while the request itself keeps waiting a week in the desktop app.
- **GET renders, POST approves** — mail scanners prefetch every link; a GET that approved
  would mean scanners approving everything on arrival. **Single use is a conditional write**,
  so a double-click or replay resumes the runner exactly once. Deny carries no approved flag.
- **Every invalid link yields ONE identical page** — wrong token, unknown run, expired, used,
  answered on desktop — so probing the URL space teaches nothing, and no page without a valid
  token reveals what was waiting. Agent-authored content is HTML-escaped: a draft cannot
  script its own approval page.
- **🪤 LIVE FAILURE (2026-07-28): a public URL needs TWO permissions.** The documented
  recipe — `lambda:InvokeFunctionUrl` for `*` with the NONE condition — is no longer enough:
  AWS's hardening means public URLs also require `lambda:InvokeFunction` for `*` under the
  same condition, and with only the first every request 403'd. The console's own warning
  banner states both actions; the condition keeps each statement URL-only. Two more traps met
  on the same road: MailPoppy's clients don't linkify plain text (the mail now carries an
  HTML button + the bare URL), and MailPoppy's in-app browser attaches its own Authorization
  header to external links, which a NONE-auth URL rejects — noted as a MailPoppy-side fix;
  the copyable URL works everywhere.
- The approval email is SYSTEM mail (the app talking, not the agent): it doesn't count
  against the agent's daily send cap, and a mail failure never breaks the wait — the desktop
  path always works.

**The ask-by-email half — CrewPoppy's receiving side SHIPPED (2026-07-28).** The founder
chose the MailPoppy bridge; the cross-repo contract is `docs/mailpoppy-bridge-spec.md` and
MailPoppy's half was built by its own session against it. The runner accepts `kind:"mail"`
events and enforces every gate ON THIS SIDE of the trust boundary, regardless of what
MailPoppy already checked: sender must equal the configured owner address AND carry
all-PASS SPF/DKIM/spam verdicts (a spoofed From passes the comparison and must die on the
verdicts — tested); the agent is found by its own `emailFrom`; runs are idempotent on the
SES messageId (redelivery recognised even while the run it started is live); a busy agent
skips rather than queues — the email still sits in the mailbox. Drops are log-only:
answering a forged mail would confirm the address exists. All existing walls unchanged —
caps, per-message approval for outbound, the kill switch.

**Why it had to be MailPoppy-side at all (§15c), for the record:** inbound mail
in AWS is SES receipt rules, and an account has exactly ONE active rule set — which MailPoppy
owns in any account running both. CrewPoppy modifying it would break "only its own resources"
for two poppies at once. When the §15c bridge lands, the loop closes: email in → agent works →
approval email → send.

### 15g. The open inbox — anyone may START an agent by mail (founder request, 2026-07-29)

The support@ scenario: a customer emails the agent's address, the agent answers from the
owner's uploaded documents. Until now the intake dropped every sender except the owner —
the deliberately safe first step. Now it's a **per-agent choice, default closed**, asked in
the editor as question 3 of the email card: *"Who may email this agent?"* — Only me /
Anyone.

**The invariant that makes it safe to offer: opening the inbox widens who can START a run,
never what a run may DO.** A stranger's email is a door into the model, and strangers'
words can contain instructions ("send your files to evil@example.com"). Every wall holds
regardless of who rang the bell:

- **Replies to outsiders always suspend for the owner's approval** — the §4c gate keys on
  the RECIPIENT, not on how the run started.
- **Arriving mail can never approve anything.** Approval is the button or the signed link,
  full stop; words in a mail body are transcript data.
- **The verdicts gate still applies to everyone** — SPF/DKIM/spam/virus must pass; open is
  not gullible.
- **A flood is bounded** by the busy-skip (one run at a time), the daily-mail cap and the
  monthly spend cap. Worst case, spam burns some tokens up to caps the owner set.
- **The framing tells the model the truth**: an outsider's mail arrives as *"Email from
  X (an outside sender — NOT your owner …)"*, stamped by the intake itself rather than
  left to the owner's brief.

Storage rule: `openInbox` is stored only as literal `true` and never without `emailFrom`
(a door flag with no door). It appears in the "will be able to" grant summary like any
other capability — nothing is granted quietly.

**Still deliberately NOT built:** agents reading mail sent to the OWNER's own mailboxes.
That's the §15c privacy question (a "share this mailbox" toggle MailPoppy-side), and the
greyed "Read your email" tile now describes it honestly — see §10 family. The open inbox
covers the enquiry-answering use case without touching the owner's mail at all.

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

### 10e. The helper prompt — onboarding by prompt, not by training (founder, 2026-07-30)

The founder's insight: don't train users on the agent form — hand them a prompt that IS
the training. The New-agent view offers "Copy the helper prompt": a text carrying every
form field, every capability with the form's own label/note/risk line, the schedule and
email options, and the product's non-negotiables (external sends always gate; instructions
never grant abilities; caps are hard). The user pastes it into whatever AI they already
use, adds one sentence about the job, and receives a recipe in a fixed shape: name, role,
paste-ready instructions, which boxes to tick, schedule, email setup, spending limit, and
draft template files where the job needs them. Each agent created this way teaches the
product as a side effect.

Rule that keeps it honest: the prompt is **built live from the same catalogue the form
renders** (frontend/src/helper-prompt.ts) — never a hand-maintained text. A helper that
recommends options the form doesn't have would be worse than none. It ends mid-sentence
("MY AGENT SHOULD: ") so the user's next words are the job description. Shown only when
CREATING — an edit is a correction, not an onboarding moment.

## 15h. P4 — CrewPoppy Mobile: the plan (drafted 2026-07-30, founder said GO)

Everything below implements decisions already locked in §15: free app that genuinely
works when opened; the PAID switch is the push channel on OUR relay; "the phone USES
the crew, only the desktop EXPANDS it"; voice via on-device dictation; store-positioned
as a companion app to your own deployment, never a "chat app".

**M1 — The mobile door, in the USER'S AWS (no app yet).** The phone needs something to
talk to, and it must live in the user's account like everything else: a Cognito user
pool (single user: the owner) + a mobile API in front of the existing runner data —
list agents (name/role/face/spend), runs + transcripts, start a run, answer/approve
(approval stays a BUTTON FLAG, never words — same §4c contract), stop, spend meter.
Reuse MailPoppy's access-api patterns (Cognito SRP, tenant isolation server-side from
verified claims). ⚠️ The two live-deploy traps both fire here: cognito/apigateway
actions will stress the STS packed-policy budget (use the broker's managed-policy
splitting, don't trim), and the rating must stay "no beyond-own findings". Gate: curl
the whole API end-to-end + re-certify (new resources = new teardown surface).
**Pairing:** the desktop shows a QR (pool ids + api url + one-time password setup);
the phone scans it — no typing ARNs on glass.

**M2 — The free app.** Fork `mailpoppy/apps/mobile` (Expo RN, Cognito SRP auth,
secure storage, store runbooks) into `mobile/`; swap the mail metaphor for the crew:
the grid with faces → chat with an agent → the approval card (verbatim To/Subject/body,
Send it / changes / Don't send) → run status + kill switch + cost line. Everything
works when opened; nothing arrives on its own. Voice = the keyboard mic (free, on
device, zero code). Gate: TestFlight build the founder can drive Postie from.

**M3 — The paid switch: the push relay (OUR one server-side component).** Tiny vendor
service: device tokens + entitlement flags + APNs/FCM delivery of MINIMAL payloads
("Fatima needs your approval" — agent name and kind, never content; the app fetches
truth from the user's own API). The user's runner POSTs the ping to the relay only
when the owner has switched push ON (opt-in, documented — the §15 privacy note).
Entitlement = AgentsPoppy subscription (like MailPoppy mobile) + Apple IAP mirroring
the same entitlement (§15 store rules). Free tier: everything, minus the phone
buzzing on its own.

**M4 — The stores.** MailPoppy mobile's runbooks; listing copy per §15 positioning;
Apple review notes state: single user, own agents, own cloud, no content generated
for strangers; free tier fully functional (works without push, as their own rule
demands).

**Founder decisions needed before M1 code:** (1) confirm the price ($19.99/yr anchor,
buys the push tier); (2) iOS first, Android after? (3) app product name on the store
("CrewPoppy" alone, or "CrewPoppy Mobile").
→ **Answered (2026-07-30):** price is configured in the AgentsPoppy admin (founder will
change it freely, so no number is baked anywhere); iOS first; React Native/Expo (forking
MailPoppy mobile); store name **"CrewPoppy"**. Mobile app code lives in a separate
PRIVATE repo: `github.com/leonct74/crewpoppy-mobile` (the poppy package stays fully
open; the app never ships inside it, so nothing auditable is hidden).

**M1 status — CODE COMPLETE (2026-07-30), awaiting live verify + re-certify.**
Implementation decisions, in the family record:
- **No API Gateway.** The mobile API is a second Lambda Function URL (the pattern the
  approval endpoint proved live) with **in-code Cognito JWT verification** — RS256
  against the pool's JWKS, ~80 lines, zero AWS permissions needed to verify, zero new
  manifest actions beyond cognito-idp, zero packed-policy weight.
- **🪤 NEW FAMILY TRAP (two halves, both live-verified 2026-07-30): Cognito pools and
  CloudFormation tags.** (1) CFN does NOT propagate stack tags to user pools (their tag
  property is a map, not the standard `Tags` list) — so the two per-install values
  travel as template PARAMETERS (`AttributionAccount`/`AttributionConnection`) and are
  stamped explicitly in `UserPoolTags`. (2) Even then, CFN's Cognito handler applies
  `UserPoolTags` with a SEPARATE `cognito-idp:TagResource` call after CreateUserPool —
  the first live update rolled back on `not authorized: cognito-idp:TagResource` because
  the manifest deliberately lacked it. Fix: grant `TagResource`/`UntagResource` scoped
  to `userpool/*` (rates clean — it was the LITERAL `*` scope that produced the earlier
  unscoped finding, not the tag actions themselves). Untagged pools would be invisible
  to the host's sweep: a guaranteed certify failure and an orphan after teardown.
- **The pool has no self-signup and no recovery channel** (`AdminCreateUserOnly`,
  recovery `admin_only`): the ONE user ("owner") exists only because desktop pairing
  created it. Lost phone/password = pair again (fresh 20-char password, previous code
  dead); "Disconnect phone" = AdminDeleteUser. The password exists in exactly two
  places: Cognito (hashed) and the QR on the owner's screen — never stored, never
  logged, never in any later response.
- **The phone gets the USE half only** (§15 scope rule, enforced server-side): list
  agents / runs / transcripts, start, answer, approve, stop. No agent create/edit/
  delete routes exist at all, and the API's role carries no `dynamodb:DeleteItem`.
  `approved` crosses the wire only as the literal button boolean (§4c) — the handler
  drops anything else a crafted client sends.
- Pairing payload (QR, JSON): `{kind:"crewpoppy-pair", v:1, region, poolId, clientId,
  apiUrl, username, password}` — the cross-repo contract with crewpoppy-mobile.
- Manifest re-verified at 0.2.0: **zero findings** (cognito creates scoped to
  `userpool/*`, mutates tagged-as-self). Version bumped to 0.2.0 in the repo — the
  release MUST disclose the new cognito grants in its notes (users re-consent).
**M1 COMPLETE — LIVE-VERIFIED + RE-CERTIFIED (2026-07-31).** The full gate ran in the
founder's account: stack update deployed (after the TagResource trap above fired once,
live); pairing QR minted on the desktop; the 401 wall probed from the open internet
(uniform `{"error":"unauthorized"}` on every route, token or not, forged or real-but-
wrong-kind); the happy path proven with a real SRP sign-in from a script — access token
→ `GET /agents` → the actual crew, and the ID token correctly refused (token_use).
A "Copy pairing text" button was added under the QR after the founder's camera
"helpfully" opened the URL inside the code instead of showing the text — also needed
for the camera-less iOS Simulator in M2. **Certify: PASSED** — footprint 12 (up from
6; the door doubled it), residual sweep zero; the one ⚠️ (tag-index lag on the deleted
pool) is now documented platform-wide as normal (AGENTS.md §4, MARKETPLACE.md M7,
founder rule 2026-07-31). Released as **0.2.0** (notes disclose the cognito grants).

### 15h-M2. The app, as built (2026-07-31)

Shipped and live-tested on the founder's iPhone via TestFlight (repo:
`github.com/leonct74/crewpoppy-mobile`, private; Expo/RN SDK 56, ~1.2k lines where
MailPoppy mobile needed 7.5k — one deployment, one user, config by QR).

Pair (scan or paste) → crew cards with faces, spend and truthful badges → chat with
instant spinner → approval card (verbatim, button-only) → Stop → Settings (re-pair,
disconnect) → clear chat → attach a file.

**Founder defects found in live use, each fixed at the source:**
1. **Chat read upside-down.** An `inverted` FlatList put new messages at the top and
   carried the "working…" spinner off-screen with them, so the app looked frozen while
   the agent was thinking. Plain list, oldest first, auto-scroll only when already at
   the bottom.
2. **🪤 Run order was RANDOM, everywhere.** A run's sort key is `run#<uuid>`, so
   DynamoDB ordered a partition by a random id while every caller read
   `ScanIndexForward:false` as "newest first". Three real consequences beyond display:
   memory recall would have carried arbitrary old exchanges, and the "is this agent
   busy?" checks paged an arbitrary 25 rows and could miss a live run and start a
   second one on top of it. `shared/guardrails.ts` now owns `newestFirst`/`oldestFirst`
   and both planes sort by `startedAt`. No migration needed.
3. **The keyboard hid the newest message.** The content doesn't change when the
   keyboard opens — only the visible height — so nothing re-scrolled. Now scrolls on
   keyboard show/resize, with `useHeaderHeight()` instead of a guessed offset.
   **🪤 This came back (founder, 2026-08-01) — and the second cause is the lesson.**
   The first fix scrolled 120 ms after `keyboardWillShow`, i.e. it GUESSED when the
   resize would be done. The iOS keyboard animates for ~250–300 ms, so the scroll ran
   mid-animation, computed its target from a layout about to change, landed short, and
   nothing corrected it — broken intermittently, which is why it looked fixed. **Never
   time a scroll against an animation.** Scroll on the signals that only arrive once
   layout is FINAL: the list's own `onLayout` (fires every time KeyboardAvoidingView
   resizes it — keyboard, approval card, a composer growing to two lines) and
   `keyboardDidShow`, both unanimated so the next layout pass can't interrupt them.
   Same change: the composer now clears the home indicator (`useSafeAreaInsets`, only
   when the keyboard is down) and the trail ends in real padding, so the last bubble
   never reads as cut off.
4. **"not found" on Clear chat** when the app was newer than the deployment. Now says
   to apply the update on the computer.
5. Emoji icons → Ionicons outlines (founder: "really ugly, I would like more
   minimalistic icons").

**Attachments (0.4.0):** signed PUT for ONE key in ONE agent's prefix, 5 minutes, 10 MB
ceiling enforced at minting; bytes go phone → owner's S3, never through the Lambda
(~6 MB request cap, and the file has no business passing through that code). The mobile
role gets `s3:PutObject` and nothing else — no read, no delete: a read grant would turn
one stolen token into a copy of every file the crew owns. **Honest scope:** text
documents work end to end; a PDF uploads but no agent can READ one (CrewPoppy writes
PDFs, never parses them); images upload but need vision in the runner. Both are named
follow-ups, deliberately not half-wired.

6. **A long approval could be neither read nor approved.** The approval card was an
   unbounded `View`: a multi-paragraph proposed email grew it until "Send it" was
   pushed off the bottom, and nothing scrolled (founder, 2026-08-01). This is a §4c
   problem, not a cosmetic one — the owner approves THAT text, so all of it must be
   readable. Now the body scrolls in a box capped at ~30% of the window (works from an
   SE to a Max) with the recipient, subject and buttons pinned outside it, plus a
   "▾ scroll to read the rest" cue, because a scroll indicator alone is missable —
   which is exactly how the founder got stuck. Same for a long waiting-question.

7. **The phone ignored the face you chose.** The mobile `Avatar` drew a tinted disc
   with initials and used the avatar id for nothing but its hue — so picking a
   different face on the desktop changed the colour slightly and never the face
   (founder, 2026-08-01). It was deferred in M2 as "needs an SVG runtime, a later
   polish"; in use it reads as the app ignoring you. Fixed by adding
   `react-native-svg` and porting `traits()` + the drawing 1:1 from
   `frontend/src/avatars.tsx`. The API had been sending the id all along, so no
   backend or deployment change. **⚠️ The two renderers must now be kept in sync** —
   an agent stores only an id, and both platforms have to turn it into the same face.
   🪤 React Native's colour parser rejects the CSS Color 4 space-separated
   `hsl(h s% l%)` the desktop uses, and an unparseable colour draws nothing at all, so
   the port uses the comma form.

**Open for M2:** PDF text extraction · image/vision support · a real device-camera QR
scan (only paste has been exercised) · re-certify before the next catalogue release
(0.3.0 and 0.4.0 both changed the stack) · `npx expo-doctor` flags a pre-existing
app.json schema warning (top-level `splash` is no longer a valid key) — harmless today,
builds pass, but worth clearing before it becomes a build failure.

**Known imperfection, accepted by the founder (2026-08-01):** the chat *usually* but
not *always* scrolls clear of the keyboard. The layout-driven fix above removed the
systematic failure (the timer race) and the founder judged the result "acceptable,
though not perfect" — so it was deliberately left rather than re-engineered on top of
a working chat. The most likely remaining cause is `scrollToEnd` on a `FlatList` with
variable-height rows: VirtualizedList estimates the offsets of rows it has not measured
yet, so the computed end can be short by a bubble. Candidate cures, in order of
preference if this is ever picked up: (a) iOS's own
`automaticallyAdjustKeyboardInsets` on the list, dropping KeyboardAvoidingView for the
list half; (b) `maintainVisibleContentPosition`. Do NOT reach for a second timer —
that is the bug this replaced.

### 15i. Approval channels — owner's choice, PER AGENT (founder, 2026-08-01 — BUILT 2026-08-01, in the next release)

Now that the phone exists, the email link is one approval channel of two. The choice is
the OWNER'S, made explicitly — never inferred by the system from "a phone is paired" or
"push is on" (founder, 2026-08-01: automatic switching is wrong because the same owner
may want email for some agents and the app for others). So the setting is **per agent**,
on each agent's card in the desktop: approve by **email** OR by **phone** — a two-way
choice (founder's correction: one channel per agent, deliberately chosen, not a "both"
that splits attention). Default stays email for every agent, including new ones — email
works with no phone at all, and an owner who never opens the setting gets exactly
today's behaviour. Choosing phone requires a paired phone with push on at the moment of
choosing.

Semantics: the channel controls WHERE the approval is offered (send the §15e link /
ping the relay) — the gate itself never weakens, and the desktop always shows waiting
approvals regardless of channel. Phone mode must (a) skip sendApprovalLink for that
agent, (b) treat "an approver exists" in mailIntake as satisfied by the push opt-in
row, (c) still handle the no-owner-email case: with no owner address, NO recipient is
free — everything gates, which is safe.

**The dead-phone trap (founder, 2026-08-01):** an owner who deletes the app (or turns
push off) while agents are set to phone would silently stop hearing about approvals —
scheduled runs would gate forever, unseen. Mitigations, all required: (1) the runner's
ping is not fire-and-forget for phone-channel agents — it reads the relay's answer, and
when the relay reports **no registered device** for the pool (Expo prunes dead tokens on
DeviceNotRegistered), the runner falls back to sending the approval EMAIL for that run.
The fallback is a safety net when the chosen channel is verifiably dead, not a third
choice. (2) Turning push OFF in the app warns when any agent is set to phone approval.
(3) The desktop agent card shows the chosen channel, and shows a warning on
phone-channel agents whenever the push opt-in row is off. App deletion without opening
it defeats (2) — that's exactly what (1) exists for.

Also fix the dispatcher's refusal text: it says "no email address has been set up for
you" when the missing thing is the APPROVER address, which misled the founder when the
agent had its own emailFrom.

**As built (2026-08-01):** `approvalChannel?: "email"|"phone"` on AgentDef — stored only
as the literal `"phone"`, so email is absence and every pre-§15i agent already means
email. Editor picker ("When … needs your OK, reach you…") with an honest warning when no
phone is notifying (GET /mobile now returns `pushEnabled`). Runner: phone channel AWAITS
`pushPing` — now returning `"delivered" | "silent"` — and sends the email link only when
the answer is silent; email channel unchanged (link + best-effort buzz). The relay's
`delivered` was made truthful for this: it counts only Expo tickets with status "ok" and
deletes DeviceNotRegistered bindings, so an uninstalled app stops counting on the next
ping. Dispatcher: three refusals that name the actual missing thing (owner address /
approver / from-address); phone-channel agents may PROPOSE sends with no owner address;
with no owner address no recipient is free — even mail "to the owner" gates. mailIntake:
the push opt-in row satisfies "an approver exists" for phone-channel agents; with no
owner address nobody is the owner, so only open inboxes accept mail. Mobile app (next
build): switching push off names the phone-approval agents first. Tests across all four
surfaces (372 green).

**LIVE-VERIFIED (founder, 2026-08-01):** phone-channel approval delivered end-to-end on
a real iPhone — runner → relay (entitled via admin comp, target = pool id) → buzz →
approved in the app; no email sent. Two live blockers found and fixed on the way, both
now pinned by tests: (1) the PUT /push allowlist demanded a trailing slash the app
never sends, so the notification switch could never turn on ("isn't recognised", switch
reverts) — regex now `(\/|$)`; (2) the admin Comp access form had no Target field, so a
comp for a target-checked product (crewpoppy-push keys on the pool id) granted a record
the paywall could never match — field added to agentspoppy-web admin. NOTE for 0.5.0:
the 0.4.0 in the catalogue still carries the broken allowlist — the phone channel needs
the 0.5.0 release to work for anyone but this dev install.

### 15j. The crew as a spreadsheet (founder, 2026-08-01 — BUILT)

"Download an Excel template to create agents and their configurations… export the
current agents and/or create hundreds in one go." A crew of three is a form; a crew of
three hundred is a spreadsheet, and typing it is not a product.

**CSV, not .xlsx.** Excel opens and saves CSV natively, and a spreadsheet library in a
SEA sidecar buys nothing an owner can see. One file does both jobs: **the export IS the
template** — with an empty crew it comes back as the header plus one example row to
overwrite, so the columns are never guessed.

**The contract that makes a re-upload harmless:**
- **Rows match agents BY NAME** (case-insensitive). An existing name UPDATES that agent
  in place — same id, so its runs, spend counters and files stay hers. A new name
  creates. **An import never deletes**: removing a row from the file is not a way to
  delete an agent (deletion keeps its own typed ceremony, AGENTS.md §4).
- **All-or-nothing.** The whole file is validated first; ANY broken row means nothing is
  written. "347 made it, 3 didn't" leaves a crew nobody can reason about, halfway
  through a spend commitment.
- **The money before the click** (AGENTS.md §9): the plan states how many will be
  created, how many updated, and the COMBINED monthly cap of every agent in the file.
  Three hundred agents at $10 is $3,000/month of ceiling, and the owner sees that
  sentence before "Yes, do it", not after.
- Every row goes through the SAME `saveAgent` sanitisers as the editor — a spreadsheet
  can never store what the form couldn't (unknown tool names are dropped, caps are
  bounded, a door flag with no door is cleared).
- Ceiling of `MAX_IMPORT_ROWS = 500` per upload, stated plainly rather than truncated.

**🪤 Excel is localised, and the founder's is Italian.** Excel in most of Europe saves
"CSV" with SEMICOLONS and writes 2,50 for 2.50. Splitting an Italian user's file on
commas yields one giant column and a wall of nonsense errors on a file Excel itself
wrote. So the parser DETECTS the delimiter from the header line, and a comma-decimal cap
is read as money. Both are pinned by tests.

Columns: Name · Role · Instructions · Model · Tools (space-separated) · Email address ·
Open inbox (yes/no) · Approvals (email/phone, §15i) · Monthly cap USD · Avatar ·
Schedule (JSON, as exported). Headers are matched case-insensitively by NAME, not
position, so an owner may reorder or add columns of their own. Backend: `crew-csv.ts`
(parse/export/plan/apply) behind `GET|POST /crew-csv`, where POST without `apply: true`
only ever PLANS. 15 tests cover the round-trip, the Excel-locale traps, the save, and
that a broken file writes nothing.

**🪤 A POPPY FRONTEND CANNOT DOWNLOAD ANYTHING.** The first version shipped the ordinary
web idiom — a blob URL and `<a download>` — and the button was simply DEAD: no file, no
error, nothing (founder, live, 2026-08-01). The host renders every poppy in a SANDBOXED
frame, and a sandbox without `allow-downloads` silently discards exactly that. Two ways
out exist and both live in the BACKEND, which is an ordinary local process:
1. **Write it and say where** (chosen here, and MailPoppy's "professional path"):
   `POST /crew-csv/save` → `saveCsvToDownloads()` writes into `~/Downloads`, never
   overwriting (de-duplicates to "crewpoppy-agents (2).csv"), and returns the filename
   so the UI can name it. No browser window at all.
2. The broker's one-shot passthrough (`/ext-dl/<id>/local-download/<token>`) +
   `openExternal` — needed only when the bytes exist ONLY in the webview (MailPoppy's
   decrypted attachments). Ours come from the backend already, so (1) is strictly less
   machinery. Documented here so the next poppy doesn't rediscover the dead button.
Also: the export is written with a UTF-8 BOM — without it Excel reads our own file in
the local codepage and mangles "Niccolò". Uploads keep the file picker (sandbox gates
downloads, not pickers) AND accept pasted text, which is why the parser learned TABS:
copying cells out of Excel puts tab-separated text on the clipboard.

### 15k. PROPOSED: Lite / PRO (founder, 2026-08-01 — decision pending)

**The founder's diagnosis, which is correct.** Notifications are a weak sole paywall: when an
agent drafts an invoice you asked for, the approval arrives in seconds and you are still looking
at the chat. The notification tells you what the screen already says. Few people will pay for it,
and the ones who would are the ones running agents unattended — a minority of sessions.

**The proposal.**
- **Lite (free):** unlimited agents · upload documents · full use of the mobile app.
- **PRO (paid, sold in the catalogue):** reaching the outside world (email to third parties) ·
  bulk agent import from a spreadsheet · approvals routed to the phone · notifications.

**What it fixes.** PRO now correlates with *doing business*, not with convenience. An agent that
emails customers is worth paying for in a way that a buzz is not. It also keeps the free tier
genuinely useful rather than crippled, which is the right shape for adoption.

**⚠️ PROBLEM 1 — most of PRO is not technically enforceable, and this is structural.**
The current paywall works *because it lives on our server*: the push relay checks the entitlement,
and no amount of editing the client changes that. Every proposed PRO feature except notifications
executes **inside the user's own AWS**, running **source-available code they can read and edit**.
A gate on "send to a third party" is a few lines in `dispatcher.ts` on their own machine. So:
- For business customers, an entitlement check plus the PolyForm Shield licence is enough — this
  is how most source-available software monetises, and removing the gate is a licence breach even
  when it is technically trivial. That is a real deterrent to a company, and none at all to a
  hobbyist.
- **Do not "fix" this by routing outbound mail through our infrastructure.** It would make the
  gate hard, and it would destroy the product's actual promise (everything in your own account,
  nobody in the middle). The paywall must never be the reason a design gets worse.
- Recommendation: keep **at least one PRO feature genuinely server-enforced** (notifications
  already are) so the tier has a hard anchor, and accept the rest as licence-backed.

**⚠️ PROBLEM 2 — this does NOT settle the Apple question, and may sharpen it.**
Putting mobile access in Lite fixes the *completeness* objection (2.1/4.2: the app must be
useful without a purchase). It does not answer **3.1.1**, which is about unlocking *in-app*
functionality with a purchase made elsewhere — and "approvals on your phone" and "notifications"
are both experienced inside the iOS app. A clearly-named PRO tier is a more legible target than
today's single vague paid extra. Mitigation, and it costs nothing: **the iOS app must never
advertise, price, name, or link to PRO.** Features work or they don't, according to the
deployment. Selling happens on the desktop and the website, where Apple has no claim.

**Two refinements worth folding in.**
1. **Export stays free; only import is PRO.** Locking people's own crew *in* contradicts "your
   data, your exit" — which is now a published claim on the CrewPoppy page. Bulk creation is the
   power feature; getting your data out is a right.
2. **"Approvals on the phone" and "notifications" are nearly the same line item.** Without
   notifications you can still open the app and approve, so selling both invites "what exactly
   did I buy?". Collapse to one.

**One addition that makes the free tier sell PRO for us.** Let a Lite agent email **the owner**
(already not treated as reaching the outside world — §4c). Free users then experience the
approval gate working, on their own inbox, and the upgrade is "now let it write to *customers*"
rather than an abstraction. The demo does the selling.

**Open question for the founder:** unlimited agents in Lite is safe *because agents cost nothing
until they run* and the run is billed to the user's own AWS — confirm that stays true before
advertising it.

**Retire the notifications SWITCH (founder, 2026-08-01).** "I don't see the point of that
switcher if notifications happen based on entitlement." Largely right, and the diagnosis is that
the control conflates two different things:
- a **preference** ("do I want buzzes?") — which **iOS already owns**, in Settings →
  Notifications → CrewPoppy, revocable at any time. Ours is a second, worse copy of it; and
- a **consent** ("may my deployment contact AgentsPoppy's relay at all?") — which is REAL and
  must not be lost. The PUSH_SK row is the only thing standing between an owner who never wanted
  notifications and a runner that pings our server with an agent's name on every approval. That
  contact is precisely what the product promises does not happen, so it can never become
  automatic-by-default.

Replacement, to land with Lite/PRO: **buying the add-on is the consent**, and the DESKTOP writes
the opt-in row at purchase. The phone keeps only the iOS permission prompt — itself a consent
moment the user controls — and Settings shows **status, not a toggle**: "Notifications are on for
this phone" / "Your plan doesn't include notifications". This also removes the silent-failure
state found on 2026-08-01: registration is NOT entitlement-gated (only the ping is), so an
unentitled owner can flip the switch on, see "on", and never receive anything.

Evidence the switch costs more than it earns: the trailing-slash allowlist bug (§15i) — a switch
that could never turn on and reverted with no explanation — existed *because* the switch exists.

**How the price list names it (founder, 2026-08-01).** Don't sell "notifications" — that names
the mechanism, not the value. But the founder's first phrasing ("Lite: no mobile approval flow /
PRO: includes mobile approval flow") must NOT be used, for two reasons:
1. **It isn't true.** A Lite user can approve from the phone — open the app, see the waiting
   request, tap. Only the *buzz* is paid. Selling a capability people already have invites refund
   requests and contradicts the honesty the product trades on.
2. **It attacks the founder's own Apple position.** Mobile access went into Lite precisely so
   Apple could not call the app payware; a public price list stating the mobile approval flow is
   PRO-only hands a reviewer that argument in writing (§15k, Problem 2).

Use the distinction that is actually true — whether the work **comes to you or waits for you**:
**Lite: you check in on your crew · PRO: your crew reaches you.** Accurate, sells the real value
(agents keep moving while you're away from the desk instead of stalling until you next look),
never says "notifications", and stays true if other ways of reaching someone are added later.

The coherent alternative — genuinely making phone approvals PRO-only — is rejected: it means
deliberately crippling the free app, and it strengthens the payware reading rather than weakening
it.

### 15l. Recipes — a tab of tested agent setups (founder, 2026-08-03: PLAN IT; 2026-08-11: BUILT)

> *"to rush up the user experience and learning curve on utilising the agents, I want we have in
> plan to add in CrewPoppy a nice additional tab with .md templates and suggested agent setup for
> various use case we have been tested, we could potentially transform this into another payware
> feature, where some nice .md required the user to purchase them."*

**The problem it solves is real and is the biggest one left.** A new owner meets an empty grid and
a blank instructions box. Everything the product can do is downstream of writing a good brief, and
"describe the job in a sentence or two" is only easy once you have seen five that work. The editor
already has the fields; what is missing is knowing what to put in them.

**Two different things are called "templates" here — keep them apart.** §4d's templates are
*document* templates that live in an agent's own workspace (`invoice-template.md`) and are read at
run time by `workspace_read`. A **recipe** is the setup of the agent itself. The founder's sentence
asks for both — *".md templates AND suggested agent setup"* — and they belong together: the
offer-writing recipe is useless without the invoice template it is told to follow. So a recipe may
carry **workspace files**, written into the new agent's folder when it is applied. That is the same
data path the Files panel already uses, so it needs no new mechanism and no new permission.

**A recipe is data, not code, and this is the load-bearing rule.** A recipe carries a name, a role,
a suggested face, the `.md` brief, any workspace files it needs, a *suggested* tool set, a
*suggested* schedule and *suggested* caps. Applying one **fills the editor and stops** — the owner
still performs the §4c granting
ceremony, still ticks each capability, still presses save. A recipe must never be able to grant a
capability, and especially never `send_email` or (per §4e) web access. Otherwise "install this
recipe" becomes a way to talk someone into approving a tool set they did not read, which is exactly
the ceremony's purpose. Say it in the UI too: *these are suggestions; you still choose what it may
do.*

**Only ship what has actually been run.** The founder's phrase is "use cases we have been tested",
and that is the whole value — anyone can generate plausible prompts, and a recipe that fails on
first contact costs more trust than the empty box it replaced. Each recipe needs a live run before
it ships, and the honest starting set is small: the offer/invoice-from-template agent (Max, which
already exists and works), a documents-questions agent, a greeter (Postie), a scheduled digest.
Several obvious candidates are blocked on §4e and must wait for it rather than ship broken.

**On charging for them — flagging a conflict, not objecting to it.** §15 locks "free core + ONE
premium", and the whole positioning §1 rests on it; the site says the phone notifications are *the*
paid extra, in those words. Paid recipe packs make that two, and the sentence on crewpoppy.com
becomes false the day they ship. That is the founder's call, but it is a positioning change and not
a feature addition, so it should be made deliberately and the copy changed in the same release.

Two practical notes if it goes ahead: the entitlement plumbing already exists (§12, per-deployment,
checked against the AgentsPoppy checkout) so the mechanism is not new work — and **a `.md` file is
plain text the buyer can copy and repost**, so the defensible value is curation, testing and
updates over time, never secrecy. Price it as a subscription to a maintained set, or not at all.

**BUILT (2026-08-11), free — the paid question stays open.** A **Templates** tab (between "Your
crew" and Feedback, which stays last per AGENTS.md §9a) shows the catalogue as cards: face, role,
what you get, the suggested abilities in the editor's own checkbox words, and an honest "needs"
list ("Read web pages — without it, it cannot see any prices"). *Use this template* lands in the
normal editor pre-filled — name, brief, ticks, schedule, caps — and stops; nothing exists until
save. Starter files (the offer template, the pages list) are written through the same
PUT /agents/:id/files path the Files panel uses, AFTER creation, with an idempotency guard: if a
file write fails, retrying re-runs the files only, never creates a second agent.

Four recipes ship, each backed by a named live run (`shared/src/recipes.ts` cites them): the
flight-price watcher (Jerry, €90 fare found 2026-08-11), the offer/invoice writer (Max, the
review-demo agent), the documents answerer (the workspace_read path Max exercises), and the
morning web brief (web_fetch + schedule + email_owner, each leg live-verified). Web-reading
recipes carry `maxTokensPerRun` ≥ 30k — a fetched page is ~10k tokens and the 20k default dies on
page two — and a shared test enforces that rule on every future recipe, along with valid tool
names, safe file paths and sane schedules (`recipes.test.ts`).

🪤 One trap found during the build, recorded because it WILL recur: exporting recipes from the
shared barrel baked the catalogue into the **Lambda zip** — 17 KB of desktop-only data changed the
content hash and relit "update available" during the store-review freeze. recipes.ts is therefore
kept OUT of `shared/src/index.ts` (the note in that file says why); the sidecar imports the module
directly. The embedded zip is verified byte-identical (`lambda-code-71dd38c40cd0844f`), so this
feature ships with no deploy and cannot touch the pairing identity.

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
- **P6a — `web_fetch`, the general web (§4e, §4f):** an opt-in per-agent capability —
  private-network block (re-checked after every redirect), body cap, per-run fetch cap, every URL
  in the transcript, fetched bytes delimited as untrusted data, and **specific** failures for the
  two measured cases (page renders in a browser / site refused an automated request). Add it to
  `COMING_CAPABILITIES` the moment it is agreed, so the app stops implying agents can already read
  the web. **Closes the §4/P2 gap, not a new idea.**
- **P6b — the web provider seam (§4f), only when a real target needs it:** one deployment setting —
  `direct` free by default, or an owner-supplied key for a rendering/anti-bot API or a structured
  search API — behind a single unchanged agent-facing tool. **Deliberately NOT on the critical
  path:** §4f measured that Google Flights serves a no-JS fallback a plain fetch can read, so the
  flight-price watch ships in P6a with no key and no third party. P6b buys the targets that stay
  shut (retail comparison, airline-direct booking, the 403s). Resolve the three §4f questions
  before building it (who pays, data leaving the account, terms of service).
- **P7 — recipes (§15l):** a tab of tested agent setups; a recipe fills the editor and never grants
  a capability. Ships only recipes that have been run live. Whether any are paid is a §15
  positioning decision, not a build decision — resolve it before the copy is written.
- **P8 — vision (§4g):** `read_image` — an agent looks at an image in its own workspace via a
  vision model already in the list. One tool, one result field, image content blocks in the
  loop; no new permission. Gated on a real-deployment run (photo from the phone → filed →
  totalled), per the §4f lesson.
- Founder check-in at every phase gate; every live test torn down + verified clean (CLAUDE.md will
  encode this). **Bedrock note:** live tests need model access enabled in the founder's Bedrock
  console + real token spend — coordinate, and keep caps tiny during testing.

## 17. Status

**2026-08-01: 0.5.0 RELEASED — approval channels, the spreadsheet, and the fix the
catalogue needed.** Pack 6.3 MB, sha `5b57482d…`. **No certify, deliberately:**
`extension.json` and `infra/` are BYTE-IDENTICAL to the 0.4.0 tag, so the deployed
footprint is exactly the 13 resources certify passed then — every change is application
code (Lambda handlers, sidecar, frontend). Re-certifying would have torn down the
founder's live deployment mid-push-test to re-prove an unchanged footprint. **No
permission change since the 0.4.0 consent** — release notes say so explicitly.
Contents: §15i per-agent approval channel + dead-phone email fallback · the PUT /push
allowlist fix (0.4.0 shipped a notification switch that could NEVER turn on, so the
phone channel worked for nobody but the dev install — this release is what makes M3
real for users) · §15j the crew as a spreadsheet · the dead-download fix · three
refusal texts that name the missing thing. 391 tests.

**2026-08-01: 0.4.0 RELEASED — the phone app's deployment, certified and listed.**
Certify PASSED with the full 13-resource footprint (residual sweep zero; two tag-index
lag warnings, the documented-normal kind). Full B-flow: pack (6.3 MB, sha `bbb54478…`),
GitHub release v0.4.0 (notes disclose the one manifest change since the 0.2.0 consent:
cognito Tag/UntagResource), download sha-verified from outside, seed updated, live
catalogue confirmed at `/directory/catalog.json`. This closes the dev-ahead rollback
window that overwrote the dev install three times. 0.3.0 was never listed — it shipped
inside 0.4.0.

**2026-07-31: 0.2.0 RELEASED — the mobile door (P4/M1).** Full RELEASING-POPPY.md B
cycle: version bump → rebuild → 331 tests → pack (6.0 MB, sha `a23a5357…bb34eb7`) →
GitHub release v0.2.0 with the cognito grants disclosed → download sha-verified from
outside → seed updated → live catalogue confirmed serving 0.2.0 (route:
`/directory/catalog.json` — note the path; `/catalog.json` 404s and cost a false
timeout). Release-day traps for the family: (1) while a dev install runs a version
AHEAD of the catalogue, the host's update button offers the older store version — the
documented rollback path — and clicking it silently overwrites the dev build; it did,
twice, mid-verification. Ship the release before long dev-ahead windows, or warn the
founder off that button. (2) The shell's cwd can reset between commands — one build
landed in a sibling repo; always `cd` explicitly in build/install invocations.

**2026-07-30: LISTED IN THE CATALOGUE. 🎉** CrewPoppy 0.1.0 is live in the AgentsPoppy
directory: repo public (pre-public checklist passed — full-history secret scan clean),
GitHub release v0.1.0 with the platform-neutral 4.9 MB node22 package, download verified
byte-for-byte against the pinned sha256 (64e0c00e…), catalog entry served by the live
site. One trap for the family: the website's catalog validator accepts only OSI license
strings or "Other: <name>" — PolyForm Shield must be written "Other: PolyForm Shield
1.0.0", and the failure mode is a silently failed site rollout (check App Hosting when a
seed change doesn't appear). Remaining, non-blocking: swap the dev install for a real
directory install (also the moment to capture the "Set up your Crew HQ" screenshot).


**Design COMPLETE and founder-locked (2026-07-19).** All §13 decisions resolved in §14.
Implementation delegated to a SEPARATE Claude Code session per the TrafficPoppy/VPN-Poppy
model — coordinate via this DESIGN.md + commits.

## P0 — COMPLETE ✅ (live-verified + certified, 2026-07-26)

Walking skeleton done end to end in the founder's account (675546221165 / eu-west-1).
Implementation decisions: §2b. 51 unit tests green; manifest **amber, zero unscoped findings**
against the REAL `assessPermissionSet`.

**Live acceptance, all passed:**
- **Deploy** — `CrewPoppyStack` CREATE_COMPLETE with all five resources: `CrewPoppyData`
  (ACTIVE, PAY_PER_REQUEST, **TTL live on `expiresAt`** — verified against AWS, the foundation
  §5's expiring checkpoints depend on), `CrewPoppyRunner` (Active, arm64, on
  `CrewPoppyRunnerRole`), the private workspace bucket, and the in-stack log group.
- **Attribution** — all three `agentspoppy:*` tags + `agentspoppy:managed`,
  `crewpoppy:templateKey`, `crewpoppy:sourceCommit` on every resource **including the
  out-of-stack deploy bucket** (untagged there = invisible to the sweep = a guaranteed leak).
- **Leaves no trace — CERTIFIED.** `npm run certify -- --yes` ran the real teardown with the
  host's residual cleanup OFF: footprint of 6 → **`residualsAfter: []`, `passed: true`, zero
  problems, zero warnings**. Independently re-verified: tag sweep empty, and the table, Lambda,
  log group, IAM role and BOTH buckets each confirmed gone. `deletedStacks: []` is correct and
  expected — our hook had already deleted the stack before the harness's own step, which is
  precisely what a compliant hook must do. Cert: `leaves-no-trace.cert.json` (self-issued,
  manifest `987390022a2e…`; git-ignored).
- **Cost** — $0.00 throughout. Nothing invoked the model, so P0 spent no Bedrock tokens.

**Two live-gate lessons, both fixed at the source and documented in AGENTS.md §3 for every
future poppy** (each was invisible to `validate-manifest`, the rating, and all unit tests —
they only ever appear on a real deploy): the **STS packed-policy budget** and the
**collection-API / `Fn::GetAtt` trap**. Both are written up in §2b.

**Next: P1 — one agent, one run** (§16). Note for P1: it introduces the first real Bedrock
spend, so model access must be enabled in the founder's Bedrock console first, and caps stay
tiny during testing.

## P2 — COMPLETE ✅ (live-verified + RE-CERTIFIED, 2026-07-27)

Tools, the approval gate, email, and the chat run view. Live on the founder's account
(675546221165 / eu-west-1).

**Live acceptance, all passed:**
- **Tools + `ask_user`** — a run pauses, the owner answers, and the run resumes from its
  checkpoint without replaying a single earlier tool call.
- **Email to the owner** — `email_owner` delivered; the owner replied to it (replies land in
  their own inbox, since an agent without its own address sends from theirs).
- **The external-send gate (§4c), all three paths** — approve sends the STORED copy verbatim;
  typed changes are treated as a revision and send NOTHING; deny sends nothing and the agent
  explains why it asked. This is the one that had to be right, and it is.
- **Delete an agent (§3a)** — removes memory, files, runs, transcripts, checkpoint and spend
  counters, refuses while a run is live.
- **Leaves no trace — RE-CERTIFIED with REAL DATA in the account.** Deliberately run against a
  dirty install (agents, memory, an owner-email config row, run history, a populated workspace
  bucket) rather than a clean stack — a teardown of an empty deployment proves very little,
  and a non-empty bucket is exactly what CloudFormation refuses to delete. Result: footprint
  of 6 → **`residualsAfter: []`, `passed: true`, zero problems, zero warnings**, teardown hook
  ran. `deletedStacks: []` is correct and expected, as at P0: our hook deletes the stack before
  the harness's own step. Cert manifest `2d259ad24487…`.

**🪤 Harness note (AgentsPoppy, not CrewPoppy): `certify` does not EXIT.** The certification
itself completed and wrote the certificate, then the process stayed alive indefinitely — the
`finally` block's `server.close()` never resolves, or something in the broker keeps a handle
open. Harmless locally (the verdict is in the cert file) but it makes certify unusable in CI
and will bite at directory submission (MARKETPLACE M7). Worth fixing in the agentspoppy repo.

**Live failures fixed along the way**, each written up above: the model catalogue offering
brains the engine can't drive (§2c #6), and the run view being a bespoke visual pattern rather
than a chat (§10b).

**Next: P3** — schedules (an agent that runs itself), the live cost meter, the `--win32`
build, packing, screenshots, and a final certify against the shipping stack.

## P3 progress — schedules LIVE-VERIFIED ✅ (2026-07-28)

An agent ran itself on its schedule and emailed the founder at the set time, unattended —
the full chain: clock-aligned tick → heartbeat → due match in the owner's timezone →
slot-id run → email delivered. It took five live failures to get there, each one a bug
that was INVISIBLE by construction, each now recorded above with its fix and a test:

1. the runner couldn't invoke itself (§5b) — runs written, never started, no error shown;
2. `rate()` ticks aren't clock-aligned (§5b) — whether schedules worked depended on the
   deploy minute;
3. "update available" compared the template only (§5b) — the app swore it was current
   while running old code, which hid every fix behind it;
4. scheduled runs were invisible in the UI (§10b family) — success, failure and skip all
   looked like silence;
5. a corpse row from failure #1 made the no-stacking check skip the agent forever (§5b)
   — the staleness rule existed but only ONE side applied it.

The meta-lesson, worth carrying to every poppy: **every fix here added a way to SEE**
(version tags on both artifacts, a heartbeat, run re-attachment, a shared staleness
rule). A background system without built-in observability isn't done — it's undebuggable.

**P3 still open:** live cost meter, `--win32` build, pack + screenshots, final certify.

## P3 progress — the FULL EMAIL LOOP LIVE-VERIFIED ✅ (2026-07-29)

The §15c/§15e story is now real, end to end, on the founder's account: the founder
emailed the agent's own MailPoppy address → the bridge invoked the runner → the agent
did the work, produced the file, and delivered it to the owner's inbox — no approval
asked, **which is the design**: mail to the OWNER is the safe channel and never gates
(§4c; the owner IS the approver). The other half verified too: a task naming an
OUTSIDE recipient suspended at the gate and waited for the button/link. The founder's
verdict: *"its design is even better than the one I originally thought."*

Also live along the way: the two-field agent editor (approver address + a SELECT of
real MailPoppy-assigned mailboxes fed by the registry), approve-by-email links, and
PDF attachments on outgoing mail.

**P3 still open:** `--win32` build, pack + screenshots, final certify (must cover the
approval endpoint + EventBridge, which didn't exist at the P2 cert).

**2026-07-29, night: FINAL CERTIFY PASSED ✅ — after two real platform findings.**
`passed: true`, zero problems, zero warnings, `residualsAfter: []`, hook ran, footprint of
8 (incl. the approval endpoint + EventBridge ticker that postdate the P2 cert). The two
findings, both fixed the same night:
1. **The platform's cleanup backstop couldn't delete EventBridge rules** — the operator
   user's HostResidualCleanup list predates schedules (CrewPoppy is the first poppy with
   a rule). Five `events:` actions added to role-template.ts + the stored policy, and the
   founder updated the live IAM policy (agentspoppy repo, commit 7508426; the operator's
   live policy is now stored verbatim as infra/policies/agentspoppy-operator-policy.json).
2. **The teardown hook silently never ran after the node22 conversion** — certify runs
   the poppy FROM THE REPO at the manifest's entry path, and the bundle lived at
   backend/build/index.cjs while the manifest said backend/index.cjs. Every failure in
   the hook chain is a silent `.catch(() => {})`, so this surfaced only as the backstop
   hitting missing permissions. Bundle now builds AT the manifest path (MailPoppy's
   convention, for the same reason). 🪤 Platform note for AGENTS.md: a certify that
   skips the hook should SAY so loudly — two of tonight's three failed runs were this.

**2026-07-29: PACKAGED — and the pipeline changed under us, for the better.** The packer
now enforces RUNTIMES.md R1 (a poppy must never ship a runtime), so the Node-SEA sidecar
died at the pack gate. Converted to the MailPoppy shape: `backend/build/index.cjs` (esbuild
CJS, 4.7 MB), `extension.json` declares `runtime: "node22"`, AgentsPoppy provides Node.
Wins: ~115 MB/platform → **4.9 MB total**, ONE platform-neutral package (`-any.zip`,
minHost 0.3.0), and the `--win32` cross-build ceased to exist as a concept. Gotcha #1
survives unchanged — the bundle still embeds the template + Lambda zip.

**2026-07-29: the three-view desktop (founder request).** The column of full chat cards
stopped scaling at three agents — every conversation pushed the next agent off screen.
Now: (1) the **crew grid** — one compact tile per agent (face, name, role, the brief
clamped to three lines but expandable in place), columns as the window allows, rows
without limit; (2) the **editor** as its own page — the granting ceremony deserves the
room; (3) the **chat** as its own page, one agent full-width, with files/edit/delete and
a visible way back. Wording rule (founder): the label is **"Role", never "Job title"** —
a person doing the same work reads that screen too. Faces: a **built-in catalogue of 50
illustrated faces** (drawn as code, ids "av-01"…"av-50"), picked in the editor —
deliberately NOT generated per user, which would bill tokens before the first chat.
An agent stores only the id, so the artwork can be upgraded wholesale later; no face
chosen renders as initials, never a broken image.

**2026-07-29, later: the open inbox (§15g) LIVE-VERIFIED.** An outside sender's email
started a run, and the reply to that outsider stopped at the approval gate as designed —
the full support@ scenario, same day it was asked for.
