import { describe, expect, it } from "vitest";
import { handler } from "./agent-runner";

describe("agent-runner (walking skeleton)", () => {
  it("answers ok and identifies itself as the skeleton", async () => {
    const r = await handler({});
    expect(r.ok).toBe(true);
    expect(r.skeleton).toBe(true);
  });
});
