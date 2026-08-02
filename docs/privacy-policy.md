# CrewPoppy — Privacy Policy (PUBLISHED)

> **Status: PUBLISHED 2026-08-02**, live at `crewpoppy.com/privacy`, and the Privacy
> Policy URL for the CrewPoppy iOS App Store listing. It must stay reachable for as long
> as the app is listed.
>
> This file is the source of truth; the website renders its own copy in
> `crewpoppy-web/src/app/privacy/page.tsx`. **Change both in the same commit** — they
> drifted once already, and the file labelled "source of truth" was the one that was
> wrong.
>
> Every claim here is a statement about what the code actually does. If the data flows
> change, this changes with them, or the policy becomes false rather than merely stale.

---

**Last updated:** 2 August 2026

This policy explains what personal data we collect and why, for **CrewPoppy** — the
desktop app, the phone app, and this website.

It is short, because CrewPoppy is built so that we hold almost nothing.

## Who we are

The data controller is **Olly Digital**, established in Amsterdam, the Netherlands
(Dutch Chamber of Commerce, KvK no. 68745532). For any privacy question or request,
email **support@crewpoppy.com**.

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

### If you buy a paid extra — never in the phone app

**Nothing is sold inside the CrewPoppy phone app.** It contains no purchases, no
subscriptions and no upgrades, and there is no way to pay for anything in it. The paid
extras described here belong to the **desktop** app and are bought on our website.

This distinction is not cosmetic: it is what an App Store reviewer checks against
Guideline 3.1.1, and it must stay true. If a purchase is ever added to the phone app, it
has to go through Apple's in-app purchase, and this paragraph changes with it.

When you buy one on the website, payment is processed by **Stripe**, which handles your
name, email, billing address, country, any VAT identifier and the transaction itself. **We never see or store card
numbers.** We keep the resulting invoice records because tax law requires it.

A purchase also creates a small entitlement record: an opaque buyer identifier, which
product was bought, what it applies to, and whether the subscription is active.

*Legal basis: performance of our contract, and our legal obligation to keep tax
records.*

### When you visit this website

Our hosting keeps ordinary technical logs (IP address, browser type, requests) for a
short period, to run and secure the site.

There is **no analytics on crewpoppy.com** — no Google Analytics, no advertising or
tracking network, and no product analytics of our own. If a TrafficPoppy site is ever
created for crewpoppy.com, this paragraph and the site's `layout.tsx` change together.

*Legal basis: our legitimate interest in running, securing and debugging the service.*

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
**support@crewpoppy.com**.

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
and object to certain processing. Email **support@crewpoppy.com**. You may also
complain to the Dutch data protection authority, the *Autoriteit Persoonsgegevens*.

## Children

CrewPoppy is a business tool and is not directed at children.

## Changes

We may update this policy; the date at the top always reflects the current version.
Material changes will be highlighted where we can.

Questions? **support@crewpoppy.com**

---

## Maintenance notes

**This must keep matching the Apple privacy questionnaire** — a mismatch is itself a
problem:
- *Identifiers → Device ID*: **collected**, purpose **App Functionality**, **not** used
  for tracking, **not** linked to identity. (The notification token.)
- Everything else — contact info, user content, location, browsing, search, health,
  financial: **not collected** by the app.
- "Do you use data for tracking?" → **No.**

**Purchases are deliberately described as desktop-and-website only.** That is not
cosmetic wording: an App Store reviewer checks it against Guideline 3.1.1. If a purchase
is ever added to the phone app it must go through Apple's in-app purchase, and this
policy, the Terms, and the review notes all change with it.

**Expo is named as a processor** because the push token is obtained through Expo's
service and notifications are delivered through it. If delivery ever moves to Apple
directly, that line goes.
