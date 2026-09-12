#!/usr/bin/env node
/**
 * Release preflight: refuse to pack a package that cannot be rebuilt from its own tag.
 *
 *   npm run check:release        (ALLOW_UNRELEASED=1 downgrades it to a warning)
 *
 * WHY. The build bakes HEAD's commit sha into the shipped bundle as `sourceCommit` — deliberate
 * provenance, and correct. But it means the package's sha256 is a function of WHICH COMMIT was
 * checked out when it was packed. Pack before the release commit exists and the package records
 * the previous commit, so `git checkout <tag> && rebuild` produces different bytes and the
 * catalogue's pinned sha256 can never be reproduced by anyone.
 *
 * That is not hypothetical — it is what every published package did, because the runbook said to
 * pack first and commit second:
 *
 *   trafficpoppy   v0.2.7  built from abd47061, tag is 00d652a2
 *   liveopspoppy   v0.3.5  built from 6faa62b7, tag is 78a98353
 *   affiliatepoppy v0.1.4  built from 3c54341d, tag is 3688eecd
 *   crewpoppy      v0.9.5  built from 99ac4dc3, tag is 8dfdac1f
 *   mailpoppy     v0.1.26  built from 61e5ee3b, and from a DIRTY tree
 *
 * Fixing the archive mtime (the sibling change) removed the clock from the bytes. It could not
 * fix this: the commit is still an input, and the only way to make it the RIGHT commit is to
 * commit and tag BEFORE packing. This refuses to let that be got wrong silently.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "extension.json");
const lenient = process.env.ALLOW_UNRELEASED === "1";

const problems = [];
const git = (args) => execFileSync("git", args, { cwd: repoRoot }).toString().trim();

if (!existsSync(join(repoRoot, ".git")) && !existsSync(manifestPath)) {
  console.error("check:release: not a checkout of this repo.");
  process.exit(1);
}

const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
const expected = `v${version}`;

// 1. A dirty tree is unreproducible from ANY commit — no tag can describe it.
let dirty = "";
try {
  dirty = git(["status", "--porcelain"]);
} catch {
  console.error("check:release: could not read git status — pack from a real checkout.");
  process.exit(1);
}
if (dirty) {
  problems.push(
    `the working tree is dirty (${dirty.split("\n").length} file(s)).\n` +
      `     A package built from uncommitted changes cannot be rebuilt from any commit.\n` +
      `     Commit (or stash) first, then tag, then pack.`,
  );
}

// 2. HEAD must carry the tag this version ships under, because HEAD's sha goes INTO the bytes.
let tags = [];
try {
  tags = git(["tag", "--points-at", "HEAD"]).split("\n").filter(Boolean);
} catch { /* handled below */ }

if (tags.length === 0) {
  problems.push(
    `HEAD (${git(["rev-parse", "--short", "HEAD"])}) carries no tag.\n` +
      `     The build bakes HEAD's sha into the package, so packing here produces bytes that\n` +
      `     ${expected} will not reproduce. Commit, then \`git tag ${expected}\`, then pack.`,
  );
} else if (!tags.includes(expected)) {
  problems.push(
    `HEAD is tagged ${tags.join(", ")}, but the manifest says version ${version}.\n` +
      `     Expected a ${expected} tag on HEAD. Bump the manifest or fix the tag — whichever is wrong.`,
  );
}

if (problems.length === 0) {
  console.log(`✅ release preflight: HEAD is clean and tagged ${expected} — this pack is reproducible from the tag.`);
  process.exit(0);
}

const label = lenient ? "⚠️  release preflight (ALLOW_UNRELEASED=1 — not blocking)" : "❌ release preflight FAILED";
console.error(`\n${label}\n`);
for (const p of problems) console.error(`  • ${p}\n`);
console.error(
  lenient
    ? "  Continuing anyway. Do NOT publish this package — its sha256 will not be reproducible.\n"
    : "  Correct order:  build → commit → tag → PACK → publish the asset.\n" +
      "  For a throwaway local build, re-run with ALLOW_UNRELEASED=1.\n",
);
process.exit(lenient ? 0 : 1);
