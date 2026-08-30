import { describe, expect, it } from "vitest";
import { updateNotice } from "./update-notice";

// The banner is the only route by which a template-only change (a security update, say)
// reaches an existing deployment. Describing one as new engine abilities teaches the user
// that this banner overstates — and the next one they skip might be the one that matters.
describe("the update banner's copy", () => {
  const CODE = "lambda-code-97d6f432d6d90661.zip";

  it("says the engine is included when the deployed runner differs from ours", () => {
    const n = updateNotice({ deployedLambdaKey: "lambda-code-oldoldoldoldold.zip", currentLambdaKey: CODE });
    expect(n.infrastructureOnly).toBe(false);
    expect(n.body).toMatch(/engine/i);
  });

  it("does NOT claim engine changes or new abilities when only the setup moved", () => {
    // The exact case this exists for: the permissions-boundary update moves the template
    // hash and no Lambda code at all.
    const n = updateNotice({ deployedLambdaKey: CODE, currentLambdaKey: CODE });
    expect(n.infrastructureOnly).toBe(true);
    expect(n.title).toMatch(/security/i);
    expect(n.body).toMatch(/doesn't change CrewPoppy's engine/i);
    expect(n.body).not.toMatch(/new abilities/i);
  });

  it("falls back to the engine wording when the deployed runner is UNKNOWN", () => {
    // A stack older than the runner tag reports no key. We don't know what it runs, so
    // the copy must not assert either way — and applying the update does ship the engine.
    const n = updateNotice({ deployedLambdaKey: undefined, currentLambdaKey: CODE });
    expect(n.infrastructureOnly).toBe(false);
    expect(n.body).toMatch(/engine/i);
    // ...but it never claims to KNOW the deployed engine is older than this build's.
    expect(n.body).not.toMatch(/is newer|out of date|older/i);
  });

  it("never claims the engine is unchanged on a guess — an unknown current key is not proof", () => {
    const n = updateNotice({ deployedLambdaKey: CODE, currentLambdaKey: undefined });
    expect(n.infrastructureOnly).toBe(false);
  });

  it("always says how long it takes and that nothing is lost — the reason people click it", () => {
    for (const n of [
      updateNotice({ deployedLambdaKey: CODE, currentLambdaKey: CODE }),
      updateNotice({ deployedLambdaKey: "lambda-code-old.zip", currentLambdaKey: CODE }),
    ]) {
      expect(n.body).toMatch(/about a minute/i);
      expect(n.body).toMatch(/nothing your crew has learned is lost/i);
      expect(n.title).toMatch(/ready for your AWS account/i);
    }
  });
});
