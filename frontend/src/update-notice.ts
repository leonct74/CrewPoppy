// What the "update available" banner should SAY.
//
// Two things version independently in a user's account: the engine (the agent-runner
// Lambda) and the AWS setup around it (the CloudFormation template — roles, permissions,
// the security ceiling on those roles). `updateAvailable` goes true when EITHER moves, so
// one fixed sentence about "new abilities" is wrong for half of them: a security update
// that changes only the template contains no engine code and adds no ability at all.
//
// This banner is the ONLY route by which a template-only change reaches an existing
// deployment — the deploy button is gone once a stack exists — so a user who learns the
// banner exaggerates is a real cost, not a copy nitpick.
//
// The status endpoint gives us enough to tell them apart: it reports the deployed runner
// key AND the one this build ships (stack.ts records both as stack tags). Equal ⇒ the
// engine is provably unchanged ⇒ this update is infrastructure only. Anything else —
// including a stack old enough to carry no runner tag, where we genuinely do not know —
// gets the engine wording, which is phrased to be true without claiming the deployed
// engine is older than ours.

import type { DeploymentStatus } from "./types";

export interface UpdateNotice {
  title: string;
  body: string;
  /** True when the engine is PROVABLY unchanged: template/setup only. */
  infrastructureOnly: boolean;
}

export function updateNotice(
  status: Pick<DeploymentStatus, "deployedLambdaKey" | "currentLambdaKey">,
): UpdateNotice {
  const infrastructureOnly =
    !!status.deployedLambdaKey &&
    !!status.currentLambdaKey &&
    status.deployedLambdaKey === status.currentLambdaKey;

  if (infrastructureOnly) {
    return {
      infrastructureOnly,
      title: "A security and setup update is ready for your AWS account",
      body:
        "This one doesn't change CrewPoppy's engine — your agents go on running exactly the code they run today. " +
        "It updates the AWS setup around them: permissions, and the limits AWS puts on what CrewPoppy is allowed to do. " +
        "It takes about a minute and nothing your crew has learned is lost.",
    };
  }

  return {
    infrastructureOnly,
    title: "An update is ready for your AWS account",
    body:
      "This one includes CrewPoppy's engine — the part that runs your agents inside your account. " +
      "Until you apply it, your agents and anything scheduled keep running the code that's already deployed, " +
      "so new abilities and fixes stay out of reach. " +
      "It takes about a minute and nothing your crew has learned is lost.",
  };
}
