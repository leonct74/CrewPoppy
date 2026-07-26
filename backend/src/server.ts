// CrewPoppy backend sidecar — the HTTP surface the host proxies frontend calls to,
// plus the teardown hook. Spawned by AgentsPoppy with AGENTSPOPPY_BOOTSTRAP; listens on
// the injected loopback port (never a fixed one). See AGENTS.md §7, DESIGN.md §2.

import { createServer, type ServerResponse } from "node:http";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { S3Client } from "@aws-sdk/client-s3";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { readBootstrap, brokerCredentialsProvider } from "./boot";
import { deploy, getStatus, teardown } from "./stack";
import { consoleUrl, getCatalogue, getModelAccess } from "./bedrock";

const boot = readBootstrap();
const credentials = brokerCredentialsProvider(boot);
const region = boot.account.region;
const cfn = new CloudFormationClient({ region, credentials });
const s3 = new S3Client({ region, credentials });
const bedrock = new BedrockClient({ region, credentials });
const ctx = { accountId: boot.account.accountId, connectionId: boot.connectionId };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** One calm sentence for the UI — never a raw stack trace (AGENTS.md §9). */
function errorMessage(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.length > 400 ? `${m.slice(0, 400)}…` : m;
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "GET" && (parts.length === 0 || parts[0] === "health")) return json(res, 200, { ok: true });
    if (method === "GET" && parts[0] === "meta") {
      return json(res, 200, { account: boot.account, connectionId: boot.connectionId });
    }

    // The live deployment state, read from CloudFormation on every call. The frontend
    // holds no memory of a deploy; this is what it mounts against and polls.
    if (method === "GET" && parts[0] === "status" && parts.length === 1) {
      return json(res, 200, await getStatus(cfn, region));
    }

    // Can this account actually run Claude yet? Drives the one-time setup card. Read-only
    // and token-free — deliberately NOT a probe invocation (see bedrock.ts).
    if (method === "GET" && parts[0] === "model-access" && parts.length === 1) {
      return json(res, 200, { ...(await getModelAccess(bedrock)), consoleUrl: consoleUrl(region) });
    }

    // The curated model shortlist, each answered against this account: which are ready
    // now, which need the one-time provider form, what each is good at, relative cost.
    if (method === "GET" && parts[0] === "models" && parts.length === 1) {
      return json(res, 200, { models: await getCatalogue(bedrock), consoleUrl: consoleUrl(region) });
    }

    // Start (or update) the deploy. Returns as soon as AWS accepts it — the work
    // carries on in the background whatever the UI does.
    if (method === "POST" && parts[0] === "deploy" && parts.length === 1) {
      return json(res, 200, await deploy(cfn, s3, ctx, region));
    }

    // The teardown hook the host POSTs at the start of teardown. MUST be idempotent.
    if (method === "POST" && parts[0] === "teardown" && parts.length === 1) {
      return json(res, 200, { ok: true, ...(await teardown(cfn, s3, ctx.accountId, region)) });
    }

    return json(res, 404, { error: `No route for ${method} /${parts.join("/")}` });
  } catch (e) {
    return json(res, 500, { error: errorMessage(e) });
  }
});

const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[crewpoppy] backend listening on 127.0.0.1:${actual} (region ${region})`);
});
