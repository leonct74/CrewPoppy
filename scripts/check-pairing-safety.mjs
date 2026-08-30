#!/usr/bin/env node
/**
 * Refuse to build a release that could invalidate a paired phone.
 *
 * WHY THIS EXISTS (founder, 2026-08-12, emphatically): CrewPoppy Mobile was in Apple's
 * review queue, paired to a live deployment with one pairing code. If that code stopped
 * working, the reviewer could not get into the app and the submission failed. That window
 * has closed (founder, 2026-08-30) — but the danger it was guarding against did not, and
 * is now bigger: every REAL user's phone is paired the same way. A change that invalidates
 * pairings no longer costs one submission; it silently locks every customer out of the app
 * until they re-pair.
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
 * WHAT CHANGED (2026-08-30). This used to freeze the WHOLE template: infra/ had to be
 * byte-identical to a certified tag, and the full template hash had to match one constant.
 * That was right for a days-long freeze and wrong as a permanent rule — it fails on every
 * infrastructure change whether or not that change endangers a pairing, so the only way to
 * ship anything is to raise the constant, which is precisely the rubber-stamp this file
 * tells you not to perform. A guard you must silence to do ordinary work stops being read.
 *
 * So it now pins exactly what a pairing depends on: the three resources above (plus the
 * function the URL is bound to) and the three Outputs the app reads. Everything else in the
 * template is free to change. If THIS hash moves, a pairing-critical resource really was
 * touched — do not raise the constant; work out whether CloudFormation will replace the
 * resource or update it in place, and only move the baseline once you know.
 *
 * NOTE the baseline below was NOT moved when this was rewritten. Adding AgentsPoppy's
 * permissions boundary to the three IAM roles (broker-role-v2 step 2) is what first tripped
 * the old whole-template hash, and it leaves this one untouched: the pairing slice hashes
 * identically before and after it, because the only delta is a PermissionsBoundary property
 * on roles whose RoleNames did not move. That is the distinction this file now draws — the
 * old check could not tell "a pairing resource changed" from "the template changed at all".
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Resources a paired phone depends on. The first four are what poolId / clientId / apiUrl
 * are read from. The two Lambda permissions are here because removing one does not change
 * the pairing payload at all and still 403s every request from every paired phone — from
 * the phone's side that is indistinguishable from the pool being replaced, which is exactly
 * what this file exists to prevent.
 */
const PAIRING_RESOURCES = [
  "MobileUserPool",
  "MobileUserPoolClient",
  "MobileApiUrl",
  "MobileApiFunction",
  "MobileApiUrlPermission",
  "MobileApiInvokePermission",
];

/** Stack outputs the phone is handed at pairing time. */
const PAIRING_OUTPUTS = ["MobileUserPoolId", "MobileClientId", "MobileApiUrl"];

/**
 * Hash of the pairing-critical slice of the template. Moving this means a resource the
 * phone's credentials point at has changed shape — NOT that some unrelated part of the
 * stack was edited.
 */
const EXPECTED_PAIRING_KEY = "d15267ba5ffec460";

const bad = [];
let actual = null;

try {
  const bundle = readFileSync("backend/src/generated/backend-bundle.ts", "utf8");
  const m = /export const templateJson\s*(?::[^=]+)?=\s*("(?:[^"\\]|\\.)*")/s.exec(bundle);
  if (!m) {
    bad.push("could not read templateJson from the generated bundle — run `npm run gen:backend` first.");
  } else {
    const tpl = JSON.parse(JSON.parse(m[1]));
    const missing = [
      ...PAIRING_RESOURCES.filter((r) => !tpl.Resources?.[r]),
      ...PAIRING_OUTPUTS.filter((o) => !tpl.Outputs?.[o]),
    ];
    if (missing.length) {
      // A pairing resource vanishing is the worst case, not a reason to skip the check.
      bad.push(`pairing resources/outputs missing from the template: ${missing.join(", ")}`);
    } else {
      const slice = {
        resources: Object.fromEntries(PAIRING_RESOURCES.map((r) => [r, tpl.Resources[r]])),
        outputs: Object.fromEntries(PAIRING_OUTPUTS.map((o) => [o, tpl.Outputs[o]])),
      };
      actual = createHash("sha256").update(JSON.stringify(slice)).digest("hex").slice(0, 16);
      if (actual !== EXPECTED_PAIRING_KEY) {
        bad.push(
          `pairing-critical resources changed: ${actual} (expected ${EXPECTED_PAIRING_KEY}).\n` +
            `  One of ${PAIRING_RESOURCES.join(", ")} or their outputs is not what every paired\n` +
            `  phone's credentials point at. If CloudFormation REPLACES one of these, every\n` +
            `  existing pairing dies and each user must re-pair by hand.`,
        );
      }
    }
  }
} catch (e) {
  bad.push(`could not read the generated bundle: ${e.message}`);
}

if (bad.length) {
  console.error("\n❌ PAIRING SAFETY CHECK FAILED — this build could break every paired phone.\n");
  for (const b of bad) console.error(`  • ${b}\n`);
  console.error("  Do not raise the expected value to silence this. Work out whether the change");
  console.error("  REPLACES the resource or updates it in place, and read DESIGN §15h.\n");
  process.exit(1);
}

console.log(`✅ pairing safe: pairing-critical resources unchanged (${actual}).`);
console.log("   (The rest of the template and the Lambda code may differ — neither is read at pairing.)");
