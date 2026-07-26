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
import { DEFAULT_MODEL_ID } from "./models";

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
