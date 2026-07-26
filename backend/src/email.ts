// Where an agent's mail goes, and what it may send from (DESIGN §4c).
//
// One address per install: the owner's. It is CONFIGURATION, never a tool argument — an
// agent's "email you" tool has no recipient field at all, so this is the only thing that
// decides where its mail lands.
//
// We check an address is verified BEFORE storing it. The alternative is a setting that
// looks saved, then silently bounces every message an agent ever sends — the sort of
// failure that surfaces days later, in the one message that mattered.

import { GetEmailIdentityCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { GetCommand, PutCommand, DeleteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CONFIG_PK, OWNER_EMAIL_SK, isEmailAddress, normaliseEmail } from "@crewpoppy/shared";

export interface OwnerEmail {
  email?: string;
  /** Re-checked live on read: an identity can be removed in AWS long after we stored it. */
  verified?: boolean;
  /** One plain sentence when it isn't usable. */
  message?: string;
}

/** True when SES will accept this address as a sender for this account. */
export async function isVerifiedSender(ses: SESv2Client, address: string): Promise<boolean> {
  const email = normaliseEmail(address);
  const domain = email.split("@")[1] ?? "";
  // Two ways an address can be legitimate: verified on its own, or covered by a verified
  // DOMAIN. Checking only the address would reject every mailbox on a verified domain —
  // which is exactly how MailPoppy users have theirs set up.
  for (const identity of [email, domain]) {
    if (!identity) continue;
    try {
      const r = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: identity }));
      if (r.VerifiedForSendingStatus) return true;
    } catch {
      /* NotFound simply means "not this one" — try the next. */
    }
  }
  return false;
}

export async function getOwnerEmail(
  ddb: DynamoDBDocumentClient,
  ses: SESv2Client,
  table: string,
): Promise<OwnerEmail> {
  const r = await ddb.send(new GetCommand({ TableName: table, Key: { pk: CONFIG_PK, sk: OWNER_EMAIL_SK } }));
  const email = (r.Item as { email?: string } | undefined)?.email;
  if (!email) return {};
  const verified = await isVerifiedSender(ses, email);
  return {
    email,
    verified,
    message: verified
      ? undefined
      : `${email} is no longer verified for sending in your AWS account, so agents can't email you. Verify it again in SES, or set a different address.`,
  };
}

/** Save the address agents will use. Refuses anything AWS won't actually send from. */
export async function setOwnerEmail(
  ddb: DynamoDBDocumentClient,
  ses: SESv2Client,
  table: string,
  raw: unknown,
): Promise<OwnerEmail> {
  // Empty clears it — which switches every email tool off, honestly and immediately.
  if (raw === "" || raw === null) {
    await ddb.send(new DeleteCommand({ TableName: table, Key: { pk: CONFIG_PK, sk: OWNER_EMAIL_SK } }));
    return {};
  }
  if (!isEmailAddress(raw)) {
    throw new Error("That doesn't look like an email address. Enter one address, with no name around it.");
  }
  const email = normaliseEmail(raw);
  if (!(await isVerifiedSender(ses, email))) {
    throw new Error(
      `Your AWS account hasn't verified ${email} for sending yet, so mail from it would bounce. Verify the address (or its domain) in SES, then set it here.`,
    );
  }
  await ddb.send(
    new PutCommand({ TableName: table, Item: { pk: CONFIG_PK, sk: OWNER_EMAIL_SK, email } }),
  );
  return { email, verified: true };
}
