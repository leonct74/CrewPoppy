import { describe, expect, it, vi } from "vitest";
import { GetEmailIdentityCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getOwnerEmail, isVerifiedSender, setOwnerEmail } from "./email";

/** SES that recognises exactly the identities it was given. */
function fakeSes(verified: string[]) {
  const asked: string[] = [];
  const client = {
    send: vi.fn(async (c: unknown) => {
      const id = (c as GetEmailIdentityCommand).input.EmailIdentity!;
      asked.push(id);
      if (!verified.includes(id)) throw Object.assign(new Error("nope"), { name: "NotFoundException" });
      return { VerifiedForSendingStatus: true };
    }),
  } as unknown as SESv2Client;
  return { client, asked };
}

function fakeDdb(item?: Record<string, unknown>) {
  const sent: unknown[] = [];
  const client = {
    send: vi.fn(async (c: unknown) => {
      sent.push(c);
      return { Item: item };
    }),
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

describe("which addresses AWS will actually send from", () => {
  it("accepts an address verified on its own", async () => {
    const { client } = fakeSes(["marco@example.com"]);
    expect(await isVerifiedSender(client, "marco@example.com")).toBe(true);
  });

  // The MailPoppy case: people verify a DOMAIN, then use any mailbox on it. Checking
  // only the exact address would reject every one of them.
  it("accepts a mailbox on a verified domain", async () => {
    const { client, asked } = fakeSes(["ollydigital.com"]);
    expect(await isVerifiedSender(client, "emma@ollydigital.com")).toBe(true);
    expect(asked).toEqual(["emma@ollydigital.com", "ollydigital.com"]);
  });

  it("is not fooled by casing or stray spaces", async () => {
    const { client } = fakeSes(["marco@example.com"]);
    expect(await isVerifiedSender(client, "  MARCO@Example.com ")).toBe(true);
  });

  it("says no when neither the address nor its domain is verified", async () => {
    const { client } = fakeSes(["someone-else.com"]);
    expect(await isVerifiedSender(client, "marco@example.com")).toBe(false);
  });
});

describe("setting the address agents email you at", () => {
  it("refuses one AWS would bounce, and stores nothing", async () => {
    const { client: ses } = fakeSes([]);
    const { client: ddb, sent } = fakeDdb();
    await expect(setOwnerEmail(ddb, ses, "T", "marco@example.com")).rejects.toThrow(/hasn't verified/i);
    expect(sent).toHaveLength(0);
  });

  it("refuses anything that isn't a single plain address", async () => {
    const { client: ses } = fakeSes(["example.com"]);
    const { client: ddb, sent } = fakeDdb();
    for (const bad of ["Marco <marco@example.com>", "a@b.com, c@d.com", "not-an-address", 7]) {
      await expect(setOwnerEmail(ddb, ses, "T", bad)).rejects.toThrow(/email address/i);
    }
    expect(sent).toHaveLength(0);
  });

  it("stores a verified address, normalised", async () => {
    const { client: ses } = fakeSes(["marco@example.com"]);
    const { client: ddb, sent } = fakeDdb();
    const r = await setOwnerEmail(ddb, ses, "T", "Marco@Example.com");
    expect(r).toEqual({ email: "marco@example.com", verified: true });
    expect((sent[0] as PutCommand).input.Item).toMatchObject({ email: "marco@example.com" });
  });

  it("clearing it removes the setting, which switches the email tools off", async () => {
    const { client: ses } = fakeSes([]);
    const { client: ddb, sent } = fakeDdb();
    expect(await setOwnerEmail(ddb, ses, "T", "")).toEqual({});
    expect(sent[0]).toBeInstanceOf(DeleteCommand);
  });
});

// An identity can be removed in AWS long after we stored it. Reporting the stored value
// as fine would mean every agent email silently bounces with the UI showing green.
describe("reading it back", () => {
  it("re-checks against SES and warns when it has stopped working", async () => {
    const { client: ses } = fakeSes([]);
    const { client: ddb } = fakeDdb({ email: "marco@example.com" });
    const r = await getOwnerEmail(ddb, ses, "T");
    expect(r.verified).toBe(false);
    expect(r.message).toMatch(/no longer verified/i);
  });

  it("reports nothing set when nothing is set", async () => {
    const { client: ses } = fakeSes([]);
    const { client: ddb } = fakeDdb(undefined);
    expect(await getOwnerEmail(ddb, ses, "T")).toEqual({});
  });
});
