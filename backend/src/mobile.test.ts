// Pairing is a credential-minting flow, so the tests are about the guarantees: no
// invite email ever, the password is permanent and appears only in the returned
// payload, re-pairing re-keys rather than erroring, and revoking is idempotent.

import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_USERNAME,
  generatePassword,
  getMobileDoor,
  getMobileStatus,
  pairMobile,
  revokeMobile,
} from "./mobile";

const OUTPUTS = [
  { OutputKey: "MobileUserPoolId", OutputValue: "eu-west-1_POOL" },
  { OutputKey: "MobileClientId", OutputValue: "client123" },
  { OutputKey: "MobileApiUrl", OutputValue: "https://xyz.lambda-url.eu-west-1.on.aws/" },
];

function cfnWith(stack: Record<string, unknown> | null) {
  return {
    send: vi.fn(async () => {
      if (!stack) throw Object.assign(new Error("Stack does not exist"), { name: "ValidationError" });
      return { Stacks: [stack] };
    }),
  } as never;
}
const readyCfn = () => cfnWith({ StackStatus: "UPDATE_COMPLETE", Outputs: OUTPUTS });

function cognitoRecorder(overrides: Record<string, unknown> = {}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        calls.push({ name, input: cmd.input });
        if (name in overrides) {
          const o = overrides[name];
          if (o instanceof Error) throw o;
          return o;
        }
        return {};
      }),
    } as never,
  };
}

describe("getMobileDoor — read live from the stack, never remembered", () => {
  it("returns the three outputs when the stack is ready", async () => {
    expect(await getMobileDoor(readyCfn())).toEqual({
      poolId: "eu-west-1_POOL",
      clientId: "client123",
      apiUrl: "https://xyz.lambda-url.eu-west-1.on.aws/",
    });
  });

  it("is null when the deployed stack PREDATES the mobile door (no outputs)", async () => {
    expect(await getMobileDoor(cfnWith({ StackStatus: "CREATE_COMPLETE", Outputs: [] }))).toBeNull();
  });

  it("is null mid-operation and when there is no stack at all", async () => {
    expect(await getMobileDoor(cfnWith({ StackStatus: "UPDATE_IN_PROGRESS", Outputs: OUTPUTS }))).toBeNull();
    expect(await getMobileDoor(cfnWith(null))).toBeNull();
  });
});

describe("getMobileStatus", () => {
  it("reports paired when the one user exists", async () => {
    const { client } = cognitoRecorder({ ListUsersCommand: { Users: [{ Username: "owner" }] } });
    expect(await getMobileStatus(readyCfn(), client)).toEqual({ doorReady: true, paired: true });
  });

  it("reports unpaired, and doesn't touch Cognito when there is no door", async () => {
    const { client, calls } = cognitoRecorder();
    expect(await getMobileStatus(cfnWith(null), client)).toEqual({ doorReady: false, paired: false });
    expect(calls).toHaveLength(0);
  });
});

describe("generatePassword", () => {
  it("meets every Cognito default: 20 chars, upper, lower, digit, symbol", () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#$%^&*\-_=+]/);
    }
  });

  it("never repeats", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("pairMobile — minting the one phone login", () => {
  it("creates the user with NO invite message, sets a PERMANENT password, returns the QR payload", async () => {
    const { client, calls } = cognitoRecorder();
    const out = await pairMobile(readyCfn(), client, "eu-west-1");
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected pairing to succeed");
    const payload = out.payload as unknown as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "crewpoppy-pair",
      v: 1,
      region: "eu-west-1",
      poolId: "eu-west-1_POOL",
      clientId: "client123",
      apiUrl: "https://xyz.lambda-url.eu-west-1.on.aws/",
      username: MOBILE_USERNAME,
    });

    const create = calls.find((c) => c.name === "AdminCreateUserCommand")!;
    // SUPPRESS or Cognito emails an invite — credentials travel by QR only.
    expect(create.input.MessageAction).toBe("SUPPRESS");
    const setPw = calls.find((c) => c.name === "AdminSetUserPasswordCommand")!;
    // Permanent, or the phone lands in a forced-change flow no app screen handles.
    expect(setPw.input.Permanent).toBe(true);
    // The password in Cognito IS the password in the QR — and it exists nowhere else.
    expect(setPw.input.Password).toBe(payload.password);
  });

  it("re-pairing re-keys the SAME user rather than erroring (already exists is fine)", async () => {
    const { client, calls } = cognitoRecorder({
      AdminCreateUserCommand: Object.assign(new Error("exists"), { name: "UsernameExistsException" }),
    });
    const out = await pairMobile(readyCfn(), client, "eu-west-1");
    expect(out.ok).toBe(true);
    expect(calls.map((c) => c.name)).toContain("AdminSetUserPasswordCommand");
  });

  it("refuses calmly when the deployment predates the mobile door", async () => {
    const { client, calls } = cognitoRecorder();
    const out = await pairMobile(cfnWith({ StackStatus: "CREATE_COMPLETE", Outputs: [] }), client, "eu-west-1");
    expect(out).toEqual({ ok: false, reason: expect.stringMatching(/update/i) });
    expect(calls).toHaveLength(0); // and mints nothing
  });
});

describe("revokeMobile — cutting the phone off", () => {
  it("deletes the login; a login already gone is success", async () => {
    const gone = cognitoRecorder({
      AdminDeleteUserCommand: Object.assign(new Error("no user"), { name: "UserNotFoundException" }),
    });
    expect(await revokeMobile(readyCfn(), gone.client)).toEqual({ ok: true });
    expect(await revokeMobile(cfnWith(null), cognitoRecorder().client)).toEqual({ ok: true });
  });
});
