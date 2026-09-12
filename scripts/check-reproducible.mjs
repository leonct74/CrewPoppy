#!/usr/bin/env node
/**
 * Prove the backend bundle is a pure function of the source.
 *
 *   npm run check:reproducible
 *
 * WHY THIS SHAPE, and not the obvious one. The determinism bug this guards against was a
 * timestamp inside the Lambda zip that ships base64-inlined in backend/index.cjs, taken from
 * `git log -1 --format=%ct` — HEAD's committer date. The obvious check (build twice on one
 * machine, compare) passed the entire time the bug was live, because HEAD did not move between
 * the two builds. Touching the Lambda sources would not have caught it either: a source mtime
 * is not HEAD's commit date.
 *
 * So this perturbs every input that ISN'T the source, together, and demands the bytes not move:
 *
 *   1. git's reported commit date — via a PATH shim, so we simulate landing a new commit
 *      without writing one. This is the input that actually broke.
 *   2. source mtimes.
 *   3. the wall clock — it has moved between the two builds by construction.
 *   4. TZ — a zip's DOS timestamp is local-time-shaped, so a UTC slip shows up here.
 *
 * SOURCE_DATE_EPOCH is deliberately NOT perturbed: it is a declared input, so changing it is
 * *supposed* to change the bytes. Instead we assert the release configuration — SOURCE_DATE_EPOCH
 * unset — stamps the fixed 1980-01-01 floor.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_ARGS = ["run", "gen:backend"];
const BUNDLE = join(repoRoot, "backend/src/generated/backend-bundle.ts");

const fail = (msg) => {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
};

/** Every file the build reads as source. Touching these must not move the output. */
function sourceFiles() {
  const out = [];
  const skip = new Set(["node_modules", "dist", "generated", ".git", "cdk.out", "release", "build"]);
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (skip.has(d.name) || d.name.startsWith(".")) continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (/\.(ts|mjs|js|json)$/.test(d.name)) out.push(p);
    }
  };
  walk(repoRoot);
  return out;
}

/** A `git` that reports a different HEAD commit date, forwarding everything else to the real one. */
function gitShimDir(fakeEpoch) {
  const dir = mkdtempSync(join(tmpdir(), "poppy-gitshim-"));
  const real = execFileSync("bash", ["-lc", "command -v git"]).toString().trim();
  const shim = join(dir, "git");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "# Determinism check: any build that asks git when HEAD was committed gets a lie.",
      `for a in "$@"; do case "$a" in *%ct*|*%cd*|*%ci*|*%at*|*%ad*|*%aI*|*%cI*) echo "${fakeEpoch}"; exit 0;; esac; done`,
      `exec ${JSON.stringify(real)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  return dir;
}

function build(label, env) {
  process.stdout.write(`   building (${label}) … `);
  try {
    execFileSync("npm", BUILD_ARGS, { cwd: repoRoot, env, stdio: "pipe" });
  } catch (e) {
    console.error("\n" + (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? ""));
    fail(`the ${label} build failed.`);
  }
  if (!existsSync(BUNDLE)) fail(`the build produced no bundle at ${BUNDLE}.`);
  const sha = createHash("sha256").update(readFileSync(BUNDLE)).digest("hex");
  console.log(`bundle ${sha.slice(0, 12)}…`);
  return sha;
}

/** Decode the DOS mtime + CRC of the Lambda zip embedded in the generated bundle. */
function embedded() {
  // Linear scan, NOT a regex: these bundles carry megabytes of base64 on one line, and a
  // greedy /[A-Za-z0-9+/=]{200,}/ over that overflows the regex engine's stack.
  const src = readFileSync(BUNDLE, "utf8");
  const i = src.indexOf('"UEsDB');
  if (i < 0) fail("could not find the embedded Lambda zip in the generated bundle.");
  const end = src.indexOf('"', i + 1); // base64 contains no quote, so the next one closes it
  if (end < 0) fail("the embedded Lambda zip literal is unterminated.");
  const z = Buffer.from(src.slice(i + 1, end), "base64");
  const t = z.readUInt16LE(10);
  const d = z.readUInt16LE(12);
  const p = (n) => String(n).padStart(2, "0");
  return {
    text: `${((d >> 9) & 0x7f) + 1980}-${p((d >> 5) & 0xf)}-${p(d & 0x1f)} ${p((t >> 11) & 0x1f)}:${p((t >> 5) & 0x3f)}:${p((t & 0x1f) * 2)}`,
    crc: z.readUInt32LE(14).toString(16).padStart(8, "0"),
  };
}

console.log("Reproducibility check — the same source must produce the same bytes.\n");

// A release built from an unclean tree is unreproducible from ANY commit, whatever the stamp says.
try {
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot }).toString().trim();
  if (dirty) {
    console.log(`⚠️  working tree is DIRTY (${dirty.split("\n").length} file(s)).`);
    console.log("   The check below still means something, but a RELEASE packed from this tree");
    console.log("   would not be reproducible from any commit. Commit before packing one.\n");
  }
} catch { /* not a git checkout — fine */ }

const baseEnv = { ...process.env };
delete baseEnv.SOURCE_DATE_EPOCH;
const first = build("baseline", baseEnv);

const stamp = embedded();
if (stamp.text !== "1980-01-01 00:00:00") {
  fail(
    `the embedded Lambda zip is stamped ${stamp.text}, not the fixed 1980-01-01 00:00:00.\n` +
      `   With SOURCE_DATE_EPOCH unset the stamp must be the floor. A real date here means the\n` +
      `   build is reading a clock or a commit date again — see scripts/build-backend-bundle.mjs.`,
  );
}
console.log(`   embedded Lambda zip: stamped ${stamp.text}, CRC-32 ${stamp.crc} ✓`);

console.log("\n   perturbing: git commit date, source mtimes, wall clock, TZ");
const touched = sourceFiles();
const now = new Date();
for (const f of touched) { try { utimesSync(f, now, now); } catch {} }
const shim = gitShimDir(1234567890);
console.log(`   touched ${touched.length} source files; git shim reports commit date 1234567890`);

const second = build("perturbed", { ...baseEnv, PATH: `${shim}:${baseEnv.PATH}`, TZ: "Pacific/Kiritimati" });
rmSync(shim, { recursive: true, force: true });

if (first !== second) {
  console.error(`\n   baseline  ${first}\n   perturbed ${second}`);
  fail("the build is NOT reproducible — something outside the source changed the bytes.");
}

console.log(`\n✅ reproducible: the backend bundle is identical across both builds.`);
console.log(`   ${first}`);
