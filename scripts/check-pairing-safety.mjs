#!/usr/bin/env node
/**
 * Refuse to build a release that could invalidate a paired phone.
 *
 * WHY THIS EXISTS (founder, 2026-08-12, emphatically): CrewPoppy Mobile is in Apple's
 * review queue, paired to a live deployment with one pairing code. If that code stops
 * working, the reviewer cannot get into the app and the submission fails. The window is
 * days long and the damage is not undoable — Apple would have to be given a new code,
 * which may restart the queue.
 *
 * A pairing payload is: region, poolId, clientId, apiUrl, username, password.
 * Only two things on earth can break it:
 *
 *   1. Pressing "show a new pairing code" in the desktop app. That calls
 *      AdminSetUserPassword on the deployment's ONE user (backend/src/mobile.ts), so
 *      every previously issued code dies instantly. No build can cause this; only a
 *      human clicking can. It is the reason this file cannot be the whole defence.
 *
 *   2. A CloudFormation change that REPLACES MobileUserPool, MobileUserPoolClient or
 *      the MobileApiUrl function URL — because poolId/clientId/apiUrl are read from
 *      those stack outputs. THIS is what a build can do by accident, and this is what
 *      the check below prevents.
 *
 * Lambda-code-only releases are safe: CloudFormation swaps the function code and
 * replaces no resource. Every release from 0.6.0 to 0.7.1 was exactly that, which is
 * why the template hash below has not moved.
 *
 * If this fails, do NOT "update the expected hash to make it pass". Read what changed
 * in infra/ and decide deliberately whether it replaces a pairing resource. Once Apple
 * has approved the app, the constraint relaxes and this guard can be retired or its
 * baseline moved on purpose.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The last release whose leaves-no-trace certification covers the deployed footprint. */
const CERTIFIED_TAG = "v0.4.0";

/** The synthesized template hash every release since P0 has produced. */
const EXPECTED_TEMPLATE_KEY = "template-f642c985fc813ccc";

const bad = [];

// 1. Nothing under infra/ may differ from the certified release.
try {
  const diff = execFileSync("git", ["diff", "--name-only", CERTIFIED_TAG, "HEAD", "--", "infra/"], {
    encoding: "utf8",
  }).trim();
  if (diff) {
    bad.push(
      `infra/ differs from ${CERTIFIED_TAG}:\n    ${diff.split("\n").join("\n    ")}\n` +
        `  A template change can REPLACE the Cognito pool or the Function URL, which changes\n` +
        `  poolId/clientId/apiUrl and invalidates every pairing code that exists.`,
    );
  }
} catch (e) {
  bad.push(`could not compare infra/ against ${CERTIFIED_TAG}: ${e.message}`);
}

// 2. The generated template must hash to the known-good value.
try {
  const bundle = readFileSync("backend/src/generated/backend-bundle.ts", "utf8");
  const m = /export const templateKey\s*(?::[^=]+)?=\s*"([^"]+)"/.exec(bundle);
  if (!m) bad.push("could not read templateKey from the generated bundle — run `npm run gen:backend` first.");
  else if (m[1] !== EXPECTED_TEMPLATE_KEY) {
    bad.push(
      `template hash changed: ${m[1]} (expected ${EXPECTED_TEMPLATE_KEY}).\n` +
        `  The deployed resource set is not what the certification and the live pairing rest on.`,
    );
  }
} catch (e) {
  bad.push(`could not read the generated bundle: ${e.message}`);
}

if (bad.length) {
  console.error("\n❌ PAIRING SAFETY CHECK FAILED — this build could break the phone pairing.\n");
  for (const b of bad) console.error(`  • ${b}\n`);
  console.error("  CrewPoppy Mobile is in App Store review against a live pairing code.");
  console.error("  Do not raise the expected values to silence this. Read DESIGN §15h and decide.\n");
  process.exit(1);
}

console.log(`✅ pairing safe: infra/ identical to ${CERTIFIED_TAG}, template ${EXPECTED_TEMPLATE_KEY}`);
console.log("   (Lambda code may differ — swapping function code replaces no resource.)");
