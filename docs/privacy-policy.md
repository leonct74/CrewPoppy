# CrewPoppy — Privacy Policy (DRAFT for founder review)

> **Status: DRAFT. Not published.** This is a legal document and it is the founder's to
> approve, word by word. Everything below is written from what the code actually does
> (verified 2026-08-01), but two claims need your confirmation before this goes live —
> they are marked **[CONFIRM]**.
>
> Intended home: `crewpoppy.com/privacy`, and the Privacy Policy URL for the iOS app.
> Source of truth lives here in CrewPoppy's own repo so the website renders it rather
> than owning it.

---

**Last updated:** [DATE ON PUBLICATION]

This policy explains what personal data we collect and why, for **CrewPoppy** — the
desktop app, the phone app, and this website.

It is short, because CrewPoppy is built so that we hold almost nothing.

## Who we are

The data controller is **Olly Digital**, established in Amsterdam, the Netherlands
(Dutch Chamber of Commerce, KvK no. 68745532). For any privacy question or request,
email **support@agentspoppy.com**.

## The short version

- CrewPoppy runs **in your own AWS account**. Your agents, their instructions, their
  conversations, the documents they read and the documents they produce all live there.
  **We do not receive them and we cannot read them.**
- **There is no account to create.** No sign-up, no password, no profile with us.
- We collect nothing at all unless you turn on **notifications** or **buy something** —
  and each of those is described in full below.
- We do not sell data, we do not use advertising, and we do not track you across the
  web.

## What CrewPoppy does *not* send us

- The instructions you write for your agents.
- Anything an agent says, reads, writes or produces.
- The files in an agent's folder, or files you upload from your phone — those go from
  your device straight into your own AWS storage.
- Your AWS credentials. CrewPoppy never sees long-lived keys; the desktop app works
  through short-lived, narrowly-scoped permissions issued inside your own account.

## What we do collect, and why

### If you turn on notifications (optional)

To make your phone buzz when an agent needs you, we store two things:

- your device's **notification token**, issued by Apple and passed to us through
  Expo's push service; and
- the **identifier of the sign-in pool** in your AWS account, so we know which phones
  belong to which deployment.

When an agent needs your attention, your own system sends us the agent's **name** and
the kind of attention needed ("a question", "an approval"). That is all it sends —
never the message, never the recipient, never the content. We pass it to Apple for
delivery and do not store it. The app then fetches the real content from your own AWS
when you open it.

*Legal basis: performance of our contract with you.* Turning notifications off deletes
the device binding, and deleting the app causes Apple to report the token as dead, at
which point we remove it.

### If you buy something

Payment is processed by **Stripe**, which handles your name, email, billing address,
country, any VAT identifier and the transaction itself. **We never see or store card
numbers.** We keep the resulting invoice records because tax law requires it.

A purchase also creates a small entitlement record: an opaque buyer identifier, which
product was bought, what it applies to, and whether the subscription is active.

*Legal basis: performance of our contract, and our legal obligation to keep tax
records.*

### When you visit this website

We measure visits with **TrafficPoppy**, our own privacy-first analytics, running in
our own AWS — not Google Analytics, and no third-party advertising or tracking
network. **[CONFIRM]** It uses no cookies, stores no identifier that could single you
out, never writes your IP address to storage, records only the *hostname* a visit came
from rather than the full referring address, and honours Global Privacy Control and Do
Not Track by counting nothing at all.

Our hosting also keeps ordinary technical logs (IP address, browser type, requests) for
a short period, to run and secure the site.

*Legal basis: our legitimate interest in understanding whether the site works.*

### The phone app

The CrewPoppy iOS app contains **no analytics, no advertising and no tracking of any
kind**. It asks for the camera only to scan the pairing code shown on your computer;
nothing is photographed or stored. It asks for notification permission only if you
turn notifications on.

## Accounts and deletion

CrewPoppy creates no account with us, so there is no account to delete. The single
phone login is created by you, inside your own AWS account, and you can remove it from
the desktop app at any time. Removing CrewPoppy deletes everything it created in your
account, and the uninstall is tested to leave nothing behind.

To remove anything we hold — a notification binding, a purchase record — email
**support@agentspoppy.com**.

## Who else processes your data

Each of these operates under a data-processing agreement:

- **Stripe** — payments and billing.
- **Google (Firebase)** — hosting, and the database holding notification bindings and
  purchase records.
- **Expo** — delivery of push notifications to Apple. **[CONFIRM]**
- **Apple** — delivery of notifications to your device.

**Your own AWS account is yours, not our processor.** We provision resources there on
your instruction; we have no standing access to what they contain.

Where a processor operates outside the European Economic Area, transfers are covered by
appropriate safeguards such as the EU Standard Contractual Clauses or an adequacy
decision.

## How long we keep things

Notification bindings last until you turn notifications off, delete the app, or ask us
to remove them. Purchase and invoice records are kept for the period Dutch law requires
(currently seven years). Technical logs are kept briefly.

## Your rights

Under the GDPR you may access, correct, delete, restrict or port your personal data,
and object to certain processing. Email **support@agentspoppy.com**. You may also
complain to the Dutch data protection authority, the *Autoriteit Persoonsgegevens*.

## Children

CrewPoppy is a business tool and is not directed at children.

## Changes

We may update this policy; the date at the top always reflects the current version.
Material changes will be highlighted where we can.

Questions? **support@agentspoppy.com**

---

## Notes for the founder (delete before publishing)

**The two [CONFIRM] items.**
1. *TrafficPoppy's behaviour* — I described the privacy invariants TrafficPoppy is
   built to (no cookies, no visitor identifier at rest, IP never written, referrer
   hostname only, GPC/DNT honoured). Confirm `stats.ollydigital.com` is running a build
   where all of those hold, because this paragraph is a promise.
2. *Expo as a processor* — the push token is obtained through Expo's service and
   notifications are delivered through it. Confirm you're content to name Expo, and
   that a DPA is in place; if you later move to direct Apple delivery, this line goes.

**Matches the Apple privacy questionnaire as follows** — these must agree, or the
mismatch is itself a problem:
- *Identifiers → Device ID*: **collected**, purpose **App Functionality**, **not** used
  for tracking, **not** linked to identity. (The notification token.)
- Everything else — contact info, user content, location, browsing, search, health,
  financial: **not collected** by the app.
- "Do you use data for tracking?" → **No.**
- If you submit before wiring purchases into the app, the Stripe section still belongs
  in the policy (it covers the desktop/website purchase), but nothing about payment is
  collected *by the app*.

**Still to write:** a matching Terms of Use for crewpoppy.com. The PolyForm Shield
licence governs the software; the terms govern the service and the subscription.
