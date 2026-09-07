// Build CrewPoppy's Google Cloud edition: the backend into ONE file the host runs on its node22
// (confined), and the Crew HQ page into frontend/dist — the TypeScript in frontend/src (with the
// vendored Feedback tab) bundled for the browser, beside the static page, the token sheet and
// CrewPoppy's icon (the same mark the AWS edition wears).
import { build } from "esbuild";
import { cpSync, mkdirSync, statSync } from "node:fs";

await build({
  entryPoints: ["backend/src/server.ts"],
  outfile: "backend/index.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  logLevel: "warning",
  banner: { js: "// CrewPoppy (Google Cloud) backend — built by scripts/build.mjs from backend/src. Do not edit.\n" },
});
mkdirSync("frontend/dist", { recursive: true });
await build({
  entryPoints: ["frontend/src/app.ts"],
  outfile: "frontend/dist/app.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  sourcemap: false,
  logLevel: "warning",
  banner: { js: "// CrewPoppy (Google Cloud) — built by scripts/build.mjs from frontend/src. Do not edit.\n" },
});
for (const f of ["index.html", "poppy.css"]) cpSync(`frontend/${f}`, `frontend/dist/${f}`);
cpSync("../frontend/public/crewpoppy-icon.png", "frontend/dist/crewpoppy-icon.png");
const kb = (p) => Math.round(statSync(p).size / 1024);
console.log(`backend/index.cjs — ${kb("backend/index.cjs")} KB · frontend/dist/app.js — ${kb("frontend/dist/app.js")} KB`);
