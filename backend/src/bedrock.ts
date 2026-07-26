// Is this account actually allowed to run Claude yet?
//
// Anthropic requires every AWS account to submit a one-time use-case form before its
// models can be invoked (DESIGN §2c, §6). Until that's done, agents cannot think — so
// the dashboard has to detect the state and explain it, rather than letting the user's
// first run die on a raw AWS error.
//
// WHY WE ASK `GetFoundationModelAvailability` RATHER THAN JUST TRYING A CALL:
// AWS auto-starts the Marketplace subscription on first invoke and lets calls through
// PROVISIONALLY for ~15 minutes while it settles. Measured live: an InvokeModel returned
// a real Claude reply, then the same call failed 5 minutes later with "use case details
// have not been submitted". So a successful invocation is NOT proof of access — but
// availability reported NOT_AVAILABLE correctly throughout, including during the window.
// It is the honest signal, and it costs no tokens.
//
// The grant this needs scopes cleanly to `arn:aws:bedrock:*::foundation-model/*`
// (verified under a deliberately restricted session policy), so it keeps the manifest's
// amber/no-findings rating. The use-case APIs, by contrast, are account-level, cannot be
// scoped at all, and rate RED — which is why CrewPoppy never submits the form itself.

import {
  GetFoundationModelAvailabilityCommand,
  type BedrockClient,
} from "@aws-sdk/client-bedrock";
import {
  DEFAULT_MODEL_ID, MODEL_CATALOGUE, PROVEN_SK, isDrivable, provenPk, type ModelOption,
} from "@crewpoppy/shared";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface ModelAccess {
  /** True when agents can actually run. */
  ready: boolean;
  modelId: string;
  /** Raw AWS status strings, for the technical details view. */
  agreement?: string;
  authorization?: string;
  entitlement?: string;
  regionAvailability?: string;
  /** One calm sentence for the user (AGENTS.md §9). Absent when ready. */
  message?: string;
  /** Set when we genuinely couldn't tell (a permissions gap, AWS erroring). */
  unknown?: boolean;
}

/** A catalogue entry plus this account's live answer for it. */
export interface ModelChoice extends ModelOption {
  /** True when this model can be used right now, with no further setup. */
  ready: boolean;
  /**
   * False when CrewPoppy's own engine can't talk to this model yet (DESIGN §2c). Nothing
   * to do with the account: it's our gap, and the UI must say so rather than let someone
   * pick a brain the runner will fail on.
   */
  supported: boolean;
  /** Ready because a run actually succeeded on it, not because AWS says so. */
  proven?: boolean;
  /** We couldn't determine it — say so rather than guess either way. */
  unknown?: boolean;
}

/**
 * The curated shortlist, each entry answered against THIS account (DESIGN §2c).
 *
 * The "needs setup" badge comes from the live check, never from the `formLikely` hint —
 * so the moment the owner completes Anthropic's form, the Claude rows flip to ready by
 * themselves. Checks run in parallel; one model failing must not hide the rest, so a
 * failed lookup degrades that row to `unknown` instead of rejecting the whole list.
 */
export async function getCatalogue(
  bedrock: BedrockClient,
  ddb?: DynamoDBDocumentClient,
  table?: string,
): Promise<ModelChoice[]> {
  return Promise.all(
    MODEL_CATALOGUE.map(async (option) => {
      const access = await getModelAccess(bedrock, option.id);
      // GROUND TRUTH WINS. The agreement field lags — measured: a submitted Anthropic
      // form registers immediately while the per-model agreement still reads
      // NOT_AVAILABLE. If a run has actually completed on this model in this account,
      // the model works, and telling the user otherwise is simply false.
      const proven = access.ready ? false : await hasRunSuccessfully(ddb, table, option.id);
      const supported = isDrivable(option);
      return {
        ...option,
        supported,
        // A model we cannot drive is never "ready", whatever AWS says about the account.
        ready: supported && (access.ready || proven),
        ...(proven ? { proven: true } : {}),
        ...(access.unknown && !proven ? { unknown: true } : {}),
      };
    }),
  );
}

/** Has any run actually completed on this model here? Best-effort; false on any error. */
async function hasRunSuccessfully(
  ddb: DynamoDBDocumentClient | undefined,
  table: string | undefined,
  modelId: string,
): Promise<boolean> {
  if (!ddb || !table) return false;
  try {
    const r = await ddb.send(
      new GetCommand({ TableName: table, Key: { pk: provenPk(modelId), sk: PROVEN_SK } }),
    );
    return !!r.Item;
  } catch {
    return false;
  }
}

/** The console page where the owner completes the one-time form. */
export function consoleUrl(region: string): string {
  // The Bedrock console was redesigned in June 2026, so a deep link to a specific
  // sub-page is liable to rot inside a shipped binary. The SERVICE ROOT is stable;
  // the card tells the user what to click once they're there.
  return `https://console.aws.amazon.com/bedrock/home?region=${encodeURIComponent(region)}`;
}

const NEEDS_FORM =
  "Anthropic needs a few details about how you'll use Claude before your account can run it. It's free, takes about a minute, and you only do it once.";

/**
 * Read the live model-access state. Never throws: a failure to determine access must not
 * break the dashboard, so it degrades to `unknown` and the UI says so honestly rather
 * than claiming everything is fine.
 */
export async function getModelAccess(
  bedrock: BedrockClient,
  modelId: string = DEFAULT_MODEL_ID,
): Promise<ModelAccess> {
  try {
    const r = await bedrock.send(new GetFoundationModelAvailabilityCommand({ modelId }));
    const agreement = r.agreementAvailability?.status;
    const ready = agreement === "AVAILABLE";
    return {
      ready,
      modelId,
      agreement,
      authorization: r.authorizationStatus,
      entitlement: r.entitlementAvailability,
      regionAvailability: r.regionAvailability,
      message: ready ? undefined : NEEDS_FORM,
    };
  } catch (e) {
    return {
      ready: false,
      unknown: true,
      modelId,
      message:
        "We couldn't check whether your account can run Claude yet. You can still try — CrewPoppy will tell you if AWS asks for anything.",
      agreement: (e as Error)?.name,
    };
  }
}
