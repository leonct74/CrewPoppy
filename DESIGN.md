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
  items + S3 workspace)

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
