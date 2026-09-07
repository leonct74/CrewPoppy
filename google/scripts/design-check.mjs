// The poppy design contract's self-check (agentspoppy/packages/extension-sdk/DESIGN.md), run over
// the Crew HQ's own source: no raw colours, no glass, no clay, no font overrides. The vendored
// Feedback tab is the SDK's own shadow-rooted element (its fallbacks carry literals by design) and
// is checked by its checksum instead; the token DEFINITIONS in index.html's theme block are the one
// place a literal may appear, each with a comment.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "vendor") walk(p);
    } else if (/\.(ts|js|css|html)$/.test(name) && !name.endsWith(".test.ts")) files.push(p);
  }
};
walk("frontend/src");
files.push("frontend/index.html");

const rules = [
  { name: "no raw colours", re: /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, allow: (line) => /--poppy-[a-z-]+:\s*#[0-9a-fA-F]{6};?\s*\/\*.*\*\//.test(line) || /^\s*<!--/.test(line) },
  { name: "no glass", re: /backdrop-/ },
  { name: "no clay", re: /d97757|e08a6d/i },
  { name: "no font overrides", re: /font-family|@font-face|fonts\.googleapis/, allow: (line) => /var\(--poppy-font/.test(line) },
];
let bad = 0;
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    for (const r of rules) {
      if (r.re.test(line) && !(r.allow && r.allow(line))) {
        console.error(`✗ ${r.name}: ${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        bad++;
      }
    }
  });
}
if (bad) {
  console.error(`${bad} design-contract finding${bad === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`✓ design contract: ${files.length} files, tokens only, no glass, no clay, no font overrides`);
