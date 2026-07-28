# MailPoppy ↔ CrewPoppy bridge: agent mailboxes (spec, v1)

**From:** the CrewPoppy implementation session (founder-approved path, 2026-07-28)
**For:** the session working in the MailPoppy repo
**Decides:** how a mail sent to an agent's address starts a CrewPoppy run.

## The product feature, in one sentence

A MailPoppy mailbox can be flagged **agent-owned**; when mail arrives for it, MailPoppy
hands the message to CrewPoppy's runner, which starts an agent run — so the owner can
email `postie@theirdomain.com` "make me an offer for XYZ" from anywhere.

## What MailPoppy builds

### 1. The flag

- A mailbox gains an optional boolean, e.g. `agentOwned`, settable in the mailbox UI.
- **Disclosure in the UI when switching it on (non-negotiable):** an agent-owned mailbox
  is NOT private the way human mailboxes are — its incoming mail is handed to an AI agent
  in plain text. Say exactly that. Human mailboxes keep the sealed-to-recipient-key
  encryption untouched; nothing about their pipeline changes in this work.

### 2. The hand-off, at ingest

In the ingest path, AFTER spam/verdict processing and BEFORE (or alongside) normal
delivery, for `agentOwned` mailboxes only:

- Invoke the function named **`CrewPoppyRunner`** (fixed name, same account, same region),
  InvocationType `Event`, with the payload below.
- **Delivery to the mailbox still happens normally** — the hand-off is a copy, not a
  detour, so the owner always has the original in the mailbox.
- If the invoke fails (function absent — CrewPoppy not installed or torn down — or
  AccessDenied), log and move on. Mail delivery must never depend on CrewPoppy existing.

### 3. The payload (wire contract — CrewPoppy implements the receiving half against this)

```json
{
  "kind": "mail",
  "to": "postie@ollydigital.com",
  "from": "owner@ollydigital.com",
  "subject": "Offer for XYZ",
  "text": "Please make an offer for ...",
  "messageId": "<ses-message-id>",
  "receivedAt": "2026-07-28T18:00:00Z",
  "verdicts": { "spf": "PASS", "dkim": "PASS", "spam": "PASS", "virus": "PASS" }
}
```

- `text` is the plain-text body (strip/convert HTML; truncate at 20 000 chars).
- `verdicts` are SES's receipt verdicts, passed through verbatim and uppercased.
- `messageId` must be the stable SES message id — CrewPoppy uses it as the idempotency
  key, so a retried invoke must carry the SAME id.
- Attachments: **not in v1.** Do not forward them; mention nothing about them in the
  payload. (Future field, deliberately absent now.)

### 4. The IAM grant (manifest change, and it deserves its own sentence)

MailPoppy's manifest gains:

```json
{ "service": "lambda", "actions": ["InvokeFunction"],
  "resourceScope": "arn:aws:lambda:*:*:function:CrewPoppyRunner" }
```

- Scope to the exact function name, not `CrewPoppy*`.
- This is the platform's first **cross-poppy integration grant** — a deliberate, visible
  exception to "a poppy touches only its own resources". The manifest description must
  name it in plain language: *"If you also use CrewPoppy, mail addressed to an
  agent-owned mailbox is handed to your CrewPoppy agents. MailPoppy can start your
  agents; it can never read their data or touch anything else of theirs."*
- Platform note for the founder: AGENTS.md has no "integration grant" concept yet; this
  is the precedent-setter and should be written up there once accepted.

## What CrewPoppy builds (its own session — NOT part of this spec's work)

Listed so the boundary is explicit: accept `kind: "mail"` events; resolve the agent by
its `emailFrom` address; **drop anything whose `from` is not the configured owner
address or whose SPF/DKIM/spam verdicts aren't all PASS** (anyone can forge a From line;
a forged email must never command an agent); dedupe runs on `messageId`; run with the
email text as the task. All existing walls stay: caps, per-message approval for any
outbound send, the kill switch.

## Safety requirements on the MailPoppy side (hard)

1. Verdicts must be REAL — passed from SES receipt processing, never synthesized.
2. The hand-off happens only for mailboxes explicitly flagged; the default is off.
3. The flag's UI copy discloses the privacy difference (see §1).
4. No retry storms: at most one retry on invoke failure; never queue-and-hammer.

## Acceptance (what "done" means)

- Mail from the owner to a flagged mailbox → `CrewPoppyRunner` invoked once with the
  payload above; mail also lands in the mailbox as normal.
- Mail to an UNflagged mailbox → no invoke, pipeline byte-identical to today.
- CrewPoppy absent → mail delivery unaffected, one log line.
- The same message redelivered by SES → same `messageId` in the payload.
