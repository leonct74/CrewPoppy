// Pairing the phone (DESIGN §15h M1). The desktop is the only thing that can mint a
// mobile login: the pool allows no self-signup, so the ONE user ("owner") exists only
// because this code created it — from the desktop app the founder is already inside.
//
// The pairing payload (pool id, client id, API URL, a fresh password) crosses to the
// phone as a QR on screen — machine to machine, never typed, never emailed, never
// stored: the password lives in Cognito (hashed) and inside the QR the owner is
// looking at, and re-pairing simply mints a new one. That is also the whole recovery
// story — "forgot the phone password" = show a new QR — which is why the pool's
// account recovery is admin-only rather than a second, weaker email door.

import { randomInt } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  ListUsersCommand,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DescribeStacksCommand, type CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { stackName } from "./stack";

/** The single mobile login. A constant, because there is exactly one owner. */
export const MOBILE_USERNAME = "owner";

/** The three values the stack surfaces for the phone (infra/src/template.ts Outputs). */
export interface MobileDoor {
  poolId: string;
  clientId: string;
  apiUrl: string;
}

export interface MobileStatus {
  /** The deployed stack has the mobile door (pool + API). False = deploy an update first. */
  doorReady: boolean;
  /** A phone login exists — pairing has happened at least once. */
  paired: boolean;
}

/** What the QR encodes. The password appears HERE and nowhere else. */
export interface PairingPayload {
  kind: "crewpoppy-pair";
  v: 1;
  region: string;
  poolId: string;
  clientId: string;
  apiUrl: string;
  username: string;
  password: string;
}

/**
 * Read the door from the stack's outputs, or null when the deployed stack predates the
 * mobile door (outputs absent) or isn't ready. Read live on every call, like all
 * deployment state — never remembered (AGENTS.md §5).
 */
export async function getMobileDoor(cfn: CloudFormationClient): Promise<MobileDoor | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = out.Stacks?.[0];
    if (!stack || !/^(CREATE|UPDATE)_COMPLETE$/.test(stack.StackStatus ?? "")) return null;
    const output = (key: string) => stack.Outputs?.find((o) => o.OutputKey === key)?.OutputValue ?? "";
    const door = { poolId: output("MobileUserPoolId"), clientId: output("MobileClientId"), apiUrl: output("MobileApiUrl") };
    return door.poolId && door.clientId && door.apiUrl ? door : null;
  } catch {
    return null; // no stack = no door; the status endpoint says so calmly
  }
}

export async function getMobileStatus(
  cfn: CloudFormationClient,
  cognito: CognitoIdentityProviderClient,
): Promise<MobileStatus> {
  const door = await getMobileDoor(cfn);
  if (!door) return { doorReady: false, paired: false };
  const users = await cognito.send(new ListUsersCommand({ UserPoolId: door.poolId, Limit: 1 }));
  return { doorReady: true, paired: (users.Users ?? []).length > 0 };
}

/**
 * A password that satisfies the pool policy (min 12) AND Cognito's service defaults
 * (upper/lower/digit/symbol — unset policy flags default ON, so meet them rather than
 * depend on template details). 20 chars from a large alphabet ≈ 128 bits — stronger
 * than anything typed, because nothing here is ever typed.
 */
export function generatePassword(): string {
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+";
  const all = lower + upper + digits + symbols;
  const pick = (set: string) => set[randomInt(set.length)]!;
  // One of each class guaranteed, the rest uniform — then shuffled so the class
  // positions leak nothing.
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < 20) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/**
 * Create — or re-key — the one phone login, and return the QR payload.
 *
 * Idempotent by design: pairing a second phone, or the same phone again, just sets a
 * fresh password on the same user (AdminCreateUser tolerates "already exists"). The
 * previous QR stops working at that moment, which is exactly what "my old phone had
 * access" should mean. Tokens the old phone already holds expire on their own clock.
 */
export async function pairMobile(
  cfn: CloudFormationClient,
  cognito: CognitoIdentityProviderClient,
  region: string,
): Promise<{ ok: true; payload: PairingPayload } | { ok: false; reason: string }> {
  const door = await getMobileDoor(cfn);
  if (!door) {
    return {
      ok: false,
      reason: "Your deployment doesn't have the mobile door yet. Apply the update above first.",
    };
  }
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: door.poolId,
        Username: MOBILE_USERNAME,
        // No invite email, no SMS — the credentials travel by QR, on screen, only.
        MessageAction: "SUPPRESS",
      }),
    );
  } catch (e) {
    if ((e as { name?: string }).name !== "UsernameExistsException") throw e;
  }
  const password = generatePassword();
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: door.poolId,
      Username: MOBILE_USERNAME,
      Password: password,
      // Permanent: the phone must never land in Cognito's forced-change flow — there is
      // no UI for it, and re-pairing IS the change flow here.
      Permanent: true,
    }),
  );
  return {
    ok: true,
    payload: {
      kind: "crewpoppy-pair",
      v: 1,
      region,
      poolId: door.poolId,
      clientId: door.clientId,
      apiUrl: door.apiUrl,
      username: MOBILE_USERNAME,
      password,
    },
  };
}

/**
 * Cut the phone off: delete the login. Already-gone is success (idempotent), and the
 * door itself stays — re-pairing later just re-creates the user.
 */
export async function revokeMobile(
  cfn: CloudFormationClient,
  cognito: CognitoIdentityProviderClient,
): Promise<{ ok: boolean; reason?: string }> {
  const door = await getMobileDoor(cfn);
  if (!door) return { ok: true }; // no door, no login, nothing to revoke
  try {
    await cognito.send(
      new AdminDeleteUserCommand({ UserPoolId: door.poolId, Username: MOBILE_USERNAME }),
    );
  } catch (e) {
    if ((e as { name?: string }).name !== "UserNotFoundException") throw e;
  }
  return { ok: true };
}
