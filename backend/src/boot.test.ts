import { describe, it, expect } from "vitest";
import { brokerCredentialsProvider, readBootstrap, type BackendBootstrap } from "./boot";

const boot: BackendBootstrap = {
  connectionId: "conn-1",
  credentialsUrl: "http://127.0.0.1:9999/connections/conn-1/credentials",
  credentialsToken: "tok-abc",
  account: { accountId: "111122223333", region: "eu-west-1" },
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const creds = {
  accessKeyId: "ASIAEXAMPLE",
  secretAccessKey: "secret",
  sessionToken: "session",
  expiration: new Date(Date.now() + 3600_000).toISOString(),
};

describe("brokerCredentialsProvider", () => {
  it("returns scoped credentials on an immediate 200", async () => {
    let calls = 0;
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => { calls++; return jsonResponse(200, creds); },
      sleep: async () => {},
    });
    const c = await provider();
    expect(c.accessKeyId).toBe("ASIAEXAMPLE");
    expect(c.secretAccessKey).toBe("secret");
    expect(c.sessionToken).toBe("session");
    expect(c.expiration).toBeInstanceOf(Date);
    expect(calls).toBe(1);
  });

  it("presents the bearer token when minting", async () => {
    let auth: string | undefined;
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async (_url, init) => {
        auth = (init?.headers as Record<string, string> | undefined)?.authorization;
        return jsonResponse(200, creds);
      },
      sleep: async () => {},
    });
    await provider();
    expect(auth).toBe("Bearer tok-abc");
  });

  it("polls a supervised 202 approval until credentials arrive (the bug that caused 'not valid')", async () => {
    const seq = [
      jsonResponse(202, { approvalRequired: true, approval: { id: "appr-1" } }),
      jsonResponse(202, { approvalRequired: true, approval: { id: "appr-1" } }),
      jsonResponse(200, creds),
    ];
    let i = 0;
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => seq[i++]!,
      sleep: async () => {},
    });
    const c = await provider();
    expect(c.accessKeyId).toBe("ASIAEXAMPLE");
    expect(i).toBe(3);
  });

  it("throws a clear error when the broker refuses (paused/revoked)", async () => {
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => jsonResponse(403, { message: "connection is paused" }),
      sleep: async () => {},
    });
    await expect(provider()).rejects.toThrow(/paused/);
  });

  it("turns an unreachable broker into a calm 'waiting for AWS access', not a raw fetch error", async () => {
    // AGENTS.md §7: vending pauses whenever the user's AWS connection is unhealthy — a
    // normal, recoverable state the UI must render calmly rather than as a crash.
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      sleep: async () => {},
    });
    await expect(provider()).rejects.toThrow(/waiting for AWS access/i);
  });

  it("re-requests a fresh approval when a pending one expires", async () => {
    const seq = [
      jsonResponse(202, { approvalRequired: true, approval: { id: "appr-1" } }),
      jsonResponse(410, { message: "approval expired, request again" }),
      jsonResponse(200, creds),
    ];
    let i = 0;
    const provider = brokerCredentialsProvider(boot, {
      fetchImpl: async () => seq[i++]!,
      sleep: async () => {},
    });
    const c = await provider();
    expect(c.accessKeyId).toBe("ASIAEXAMPLE");
    expect(i).toBe(3);
  });
});

describe("readBootstrap — the permissions-boundary ARN (broker-role-v2 step 2)", () => {
  const withEnv = (value: unknown) => {
    process.env.AGENTSPOPPY_BOOTSTRAP = JSON.stringify({
      connectionId: "conn-1",
      credentialsUrl: "http://127.0.0.1:9999/c",
      account: { accountId: "111122223333", region: "eu-west-1" },
      ...(value === undefined ? {} : { permissionsBoundaryArn: value }),
    });
    try {
      return readBootstrap();
    } finally {
      delete process.env.AGENTSPOPPY_BOOTSTRAP;
    }
  };

  it("keeps a real ARN", () => {
    expect(withEnv("arn:aws:iam::111122223333:policy/AgentsPoppyBoundary").permissionsBoundaryArn).toBe(
      "arn:aws:iam::111122223333:policy/AgentsPoppyBoundary",
    );
  });

  it("trims surrounding whitespace off an otherwise-real ARN", () => {
    expect(withEnv("  arn:aws:iam::111122223333:policy/AgentsPoppyBoundary\n").permissionsBoundaryArn).toBe(
      "arn:aws:iam::111122223333:policy/AgentsPoppyBoundary",
    );
  });

  it("keeps a non-standard partition and a pathed policy — the boundary is not aws-only", () => {
    for (const arn of [
      "arn:aws-us-gov:iam::111122223333:policy/AgentsPoppyBoundary",
      "arn:aws-cn:iam::111122223333:policy/AgentsPoppyBoundary",
      "arn:aws:iam::111122223333:policy/agentspoppy/AgentsPoppyBoundary",
    ]) {
      expect(withEnv(arn).permissionsBoundaryArn).toBe(arn);
    }
  });

  it("treats anything that isn't SHAPED like an IAM policy ARN as 'not confirmed'", () => {
    // Truthiness is not enough. A malformed value passed through becomes the CFN
    // parameter, makes the HasPermissionsBoundary condition true, and fails EVERY
    // CreateRole in the stack — a rolled-back deploy instead of the graceful unbounded
    // one the optional-by-construction design promises.
    for (const bad of [
      undefined,
      "",
      "   ",
      "\t\n",
      null,
      42,
      {},
      ["arn:aws:iam::111122223333:policy/AgentsPoppyBoundary"],
      "AgentsPoppyBoundary", // a bare policy name
      "arn:aws:iam::111122223333:policy/", // no policy name at all
      "arn:aws:iam::12345:policy/AgentsPoppyBoundary", // not a 12-digit account
      "arn:aws:iam::111122223333:role/AgentsPoppyBoundary", // a role, not a policy
      "arn:aws:s3:::some-bucket", // right prefix, wrong service
      "${BOUNDARY_ARN}", // an unsubstituted template string
    ]) {
      expect(withEnv(bad).permissionsBoundaryArn, `${JSON.stringify(bad)} must not be confirmed`).toBeUndefined();
    }
  });
});
