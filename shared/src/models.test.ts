import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID, MODEL_CATALOGUE, SUPPORTED_WIRES, inferenceProfileFor, invocationIdFor,
  isDrivable, wireFor,
} from "./models";

describe("the curated model catalogue", () => {
  it("offers a genuine fast lane — models usable with no provider form", () => {
    // The whole point of the picker: nobody is ever blocked at first run.
    expect(MODEL_CATALOGUE.some((m) => !m.formLikely)).toBe(true);
    expect(MODEL_CATALOGUE.filter((m) => !m.formLikely).length).toBeGreaterThanOrEqual(2);
  });

  it("only offers models that can actually be an agent — tool use is the job", () => {
    // DESIGN §4: an agent that can't call tools can only chat. Listing one here would
    // sell a brain that can't do the work.
    for (const m of MODEL_CATALOGUE) expect(m.toolUse, `${m.label} must support tools`).toBe(true);
  });

  it("tells the user what each model is good at, in plain language", () => {
    for (const m of MODEL_CATALOGUE) {
      expect(m.goodAt.length, `${m.label} needs a description`).toBeGreaterThan(20);
      expect(m.goodAt).toMatch(/[.!]$/); // a sentence, not a fragment
    }
  });

  it("defaults to a cheap model, never the priciest (DESIGN §7)", () => {
    const dflt = MODEL_CATALOGUE.find((m) => m.id === DEFAULT_MODEL_ID);
    expect(dflt).toBeDefined();
    expect(dflt!.cost).not.toBe("$$$");
  });

  it("holds bare foundation-model ids — the form the access APIs accept", () => {
    for (const m of MODEL_CATALOGUE) expect(m.id).not.toMatch(/^(eu|us|apac)\./);
  });

  it("carries no image or embedding models — those aren't agent brains", () => {
    for (const m of MODEL_CATALOGUE) expect(m.id).not.toMatch(/canvas|embed|image|reel|sonic/i);
  });
});

describe("inference profile ids (the trap that cost a live test — DESIGN §2c)", () => {
  it("prefixes the region family, because bare ids can't be invoked on demand", () => {
    expect(inferenceProfileFor(DEFAULT_MODEL_ID, "eu-west-1")).toBe(`eu.${DEFAULT_MODEL_ID}`);
    expect(inferenceProfileFor(DEFAULT_MODEL_ID, "us-east-1")).toBe(`us.${DEFAULT_MODEL_ID}`);
    expect(inferenceProfileFor(DEFAULT_MODEL_ID, "ap-southeast-2")).toBe(`apac.${DEFAULT_MODEL_ID}`);
  });

  it("leaves an unknown region alone rather than inventing a prefix", () => {
    expect(inferenceProfileFor(DEFAULT_MODEL_ID, "ca-central-1")).toBe(DEFAULT_MODEL_ID);
  });
});

// The SECOND half of the same trap, found 2026-08-12: prefixing is per-MODEL, not
// per-region. Qwen and GPT-OSS are served in-region in eu-west-1 and publish no
// cross-region profile, so `eu.qwen…` names nothing — which is why Qwen looked
// unavailable and got written off as needing an adapter it didn't need.
describe("invocation ids are a per-model fact", () => {
  it("gives cross-region models the regional profile", () => {
    expect(invocationIdFor(DEFAULT_MODEL_ID, "eu-west-1")).toBe(`eu.${DEFAULT_MODEL_ID}`);
    expect(invocationIdFor("amazon.nova-lite-v1:0", "eu-west-1")).toBe("eu.amazon.nova-lite-v1:0");
  });

  it("gives in-region models the BARE id — the prefixed form does not exist", () => {
    expect(invocationIdFor("qwen.qwen3-32b-v1:0", "eu-west-1")).toBe("qwen.qwen3-32b-v1:0");
    expect(invocationIdFor("openai.gpt-oss-120b-1:0", "eu-west-1")).toBe("openai.gpt-oss-120b-1:0");
  });

  it("leaves an unknown id bare rather than inventing a profile for it", () => {
    expect(invocationIdFor("some.retired-model-v9:0", "eu-west-1")).toBe("some.retired-model-v9:0");
  });

  it("every catalogue entry declares which form it needs", () => {
    for (const m of MODEL_CATALOGUE) expect(typeof m.crossRegion).toBe("boolean");
  });
});

describe("wireFor", () => {
  it("reads the wire off the catalogue", () => {
    expect(wireFor(DEFAULT_MODEL_ID)).toBe("anthropic");
    expect(wireFor("qwen.qwen3-32b-v1:0")).toBe("converse");
  });

  it("assumes Anthropic for an unknown id — the only wire an old agent could carry", () => {
    expect(wireFor("some.retired-model-v9:0")).toBe("anthropic");
  });
});

// Live failure, 2026-07-26: an agent on a non-Anthropic model failed with "The provided
// model identifier is invalid". The runner only ever spoke Anthropic's format, while the
// picker offered five models — so the catalogue could hand out a brain the engine can't
// drive. The wire format is now declared, and these hold that line.
describe("the catalogue never offers a model the engine can't drive", () => {
  it("marks every entry with the format it speaks", () => {
    for (const m of MODEL_CATALOGUE) {
      expect(["anthropic", "converse"]).toContain(m.wire);
    }
  });

  it("only lets through models the runner actually implements", () => {
    // If this fails because an adapter was added, that's the point — add it to
    // SUPPORTED_WIRES in the SAME change as the adapter, never before.
    for (const m of MODEL_CATALOGUE) {
      expect(isDrivable(m)).toBe(SUPPORTED_WIRES.includes(m.wire));
    }
  });

  it("keeps the default model one we can drive", () => {
    const def = MODEL_CATALOGUE.find((m) => m.id === DEFAULT_MODEL_ID)!;
    expect(isDrivable(def)).toBe(true);
  });

  it("has at least one drivable model, or nobody can create an agent at all", () => {
    expect(MODEL_CATALOGUE.some(isDrivable)).toBe(true);
  });
});
