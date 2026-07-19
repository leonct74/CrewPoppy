# CLAUDE.md — CrewPoppy

Operating guide for working in this repo. **`DESIGN.md` is the source of truth** — read it fully
before any work; when a design decision changes, update DESIGN.md in the same change. Founder
decisions live in DESIGN §14 and are final unless the founder revisits them.

> **Boundary:** CrewPoppy is a standalone project that runs *on* AgentsPoppy (never forks it — FSL
> non-compete). The mailpoppy, vm-poppy, traffic-poppy and vpn-poppy repos are READ-ONLY reference
> material: copy patterns from them, never modify them from here.

## What this is

**CrewPoppy** ("Mission Control for your AI crew") — create a fleet of task-specific AI agents that
run **entirely in the owner's own AWS**: their prompts, memory, outputs, and token spend all in the
user's cloud, via Amazon Bedrock. Give an agent a persona (name, role), instructions, and a bounded
set of tools; run it on demand or on a schedule; approve its consequential actions; watch exactly
what it costs. Free core + one premium (**CrewPoppy Mobile**). Full rationale, locked decisions,
and phases P0–P4: `DESIGN.md`.

## Read these before coding (in order)

1. `DESIGN.md` (this repo) — product, the safety architecture, §14 locked decisions.
2. `~/Projects/agentspoppy/AGENTS.md` — the framework contract (rating, teardown, manifest, design
   kit, plain language, "Show the money"). Hard requirements.
3. Reference implementations to REUSE, not reinvent:
   - `~/Projects/mailpoppy/apps/desktop/node-sidecar` — the **embedded-template CloudFormation
     deploy pipeline** (this is P0's core pattern); `apps/desktop` — the **Cognito access-API +
     dashboard** patterns (agents ≈ mailboxes; the agent API ≈ the access API), and the
     **tenant-isolation** lesson (agent isolation is the same shape). MailPoppy **mobile**
     (`apps/mobile`) is the base for the premium app (§14.3).
   - `~/Projects/vm-poppy` — repo layout (`frontend/ backend/ scripts/`), SEA sidecar build
     (`--win32`), `tags.ts` attribution/ownership, teardown/certify, `CopyButton`, DR1–DR6.
   - `~/Projects/agentspoppy/scripts/pack-extension.mjs` — packaging (darwin + win32).

## Non-negotiables (digest — AGENTS.md + DESIGN §14 are authoritative)

- **The recursive-broker safety model is the heart (DESIGN §4).** Agents NEVER hold AWS credentials
  and NEVER call the AWS SDK. They emit **tool calls** to a **trusted tool-dispatcher** that
  implements a **fixed, curated catalogue** and enforces **per-agent scope** on every call (agent
  X's file/memory tools touch only agent X's data). Adding a tool is an engineering decision with
  its own bounds — never something an agent can escalate into. A prompt-injected agent must be
  unable to reach the account. Treat as security-critical; test isolation like MailPoppy's tenant
  isolation.
- **Tool outputs are DATA, never instructions.** Fetched web content etc. can never redefine the
  system prompt or unlock tools (prompt-injection defense).
- **Cost is capped by HARD mechanisms, not advice (DESIGN §7).** Per-run iteration(8)/token/
  wall-clock limits + per-agent monthly $ cap ($10 default) + global ceiling + kill switch + live
  meter (Bedrock usage × live Price List rates, NEVER hardcoded). The runner refuses to start a run
  that would exceed a cap and stops mid-run if crossed. A runaway agent must be impossible.
- **`ask_user` suspend/resume (DESIGN §5):** checkpoint the FULL run state to DynamoDB and exit;
  resume from the checkpoint on the owner's answer. **Idempotency rule (family lesson): resuming
  must NOT re-execute earlier tool calls** — the checkpoint is the whole truth; deterministic keys,
  never `new Date()` as a sort-key fallback.
- **Inference = Bedrock, via IAM** (no API key stored). Same for §3c avatar images (`bedrock:
  InvokeModel`, different model ids). Owner enables Bedrock model access once (surface + link it,
  like SES sandbox); region-limited — confirm availability.
- **Disclosure guardrails (DESIGN §3, §3c):** personas/avatars are encouraged but customer-facing
  agents stay disclosable as AI; avatars are synthetic (never real/scraped faces), watermarked
  "AI Avatar" + C2PA metadata, not removable in-app; conversational disclosure in customer-facing
  templates. Don't ship copy that claims an agent is human.
- **Rating:** the widest set in the family — MailPoppy-class amber, name-scoped `CrewPoppy*` /
  `MissionControlAgents*` (pick one prefix, use it everywhere). **Watch the STS packed-policy
  budget** — this set is the most likely to exceed the ~18-action DR5 ceiling; if it does, use the
  broker's **managed-policy splitting**, don't trim needed actions. Verify against the REAL
  `assessPermissionSet` (substring trap). All three attribution tags on every created resource;
  teardown hook + `npm run certify` before any catalogue listing.
- **Portability (DESIGN §3b):** the "Crew Pack" export/import must round-trip an agent's def +
  memory + workspace; teardown offers export FIRST (TrafficPoppy pattern).
- Design kit (`poppy.css`), `poppyAccent(...)`, plain language, type-to-confirm destructive actions,
  background+resume.

## Gotchas inherited from the poppy family (each cost real debugging time)

1. **🪤 Stale SEA sidecar masks backend/Lambda changes.** After ANY change to the deployed
   template/Lambdas/embedded bundle: rebuild the sidecar and fully restart the app, or deploys
   report NO_CHANGE with old code. (Bit MailPoppy repeatedly.)
2. **Never `git add -A` after building binaries** — an 86 MB sidecar once landed in vm-poppy's git
   history. `.gitignore` every artifact FIRST (sidecar binaries, `*.exe`, `release/`, `dist/`,
   `backend/`, generated bundles).
3. **Idempotency / deterministic keys** — especially in `ask_user` resume and any re-runnable
   writer; never `new Date()` as a sort-key fallback.
4. **Isolation is server-side from verified claims**, never client-side filtering (MailPoppy
   security lesson) — applies to the dashboard/agent API AND the per-agent tool scoping.

## Working agreements (live AWS)

- **Explicit founder confirmation before any AWS command that creates/changes/deletes resources.**
  Read-only calls are fine.
- Live tests run in the founder's account → **tear down afterwards and verify clean.** **Bedrock
  live tests spend real tokens** — enable model access first, keep caps tiny during testing, and
  coordinate (the founder pays for inference).
- The founder decides product questions; implementation questions get decided here and recorded in
  DESIGN.md.

## Commands (fill in as scaffolded — mirror vm-poppy's package.json)

- `npm install` · `npm run typecheck` · `npm run test` · `npm run build:sidecar` (+ `--win32`) ·
  `npm run validate-manifest` · `npm run install-dev` · `npm run certify`

## Status

Design complete + founder-locked (DESIGN §14, 2026-07-19). **Current phase: P0 — walking skeleton**
(scaffold → manifest vs real assessor, watch packed-policy budget → empty stack (DynamoDB + S3 +
empty runner Lambda + Bedrock permission) → teardown → certify green → dev-install in AgentsPoppy).
Before the repo ever goes public: the pre-public checklist in `agentspoppy/docs/ROADMAP.md`
(history secret scan, FSL headers, no personal paths).
