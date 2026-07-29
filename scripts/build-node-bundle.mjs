#!/usr/bin/env node
// Build CrewPoppy's backend as the single CJS bundle AgentsPoppy's SHARED node22
// runtime executes (extension.json backend.runtime "node22" — agentspoppy
// docs/RUNTIMES.md). This REPLACED the Node-SEA sidecar pipeline: a poppy must never
// ship a runtime (R1) — the package carries only CrewPoppy's own code, including the
// embedded CFN template + Lambda zip, and NO copy of Node. One bundle, every platform:
// the win32 cross-build died with the SEA.
//
// 🪤 The family gotcha survives the pipeline change: this bundle EMBEDS the template
// and Lambda zip. After ANY backend/infra/lambda change — rebuild this and restart the
// app, or deploys silently report NO_CHANGE with old code.
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outfile = join(repoRoot, "backend", "build", "index.cjs");

console.log("[1/2] regenerate embedded backend bundle (template + lambda zip)");
execFileSync(process.execPath, [join(here, "build-backend-bundle.mjs")], { stdio: "inherit" });

console.log("[2/2] esbuild bundle →", outfile);
mkdirSync(dirname(outfile), { recursive: true });
await esbuild.build({
  entryPoints: [join(repoRoot, "backend", "src", "server.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile,
  logLevel: "warning",
});

console.log(`✅ backend bundle → ${outfile} (${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB)`);
