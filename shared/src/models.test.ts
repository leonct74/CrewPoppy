import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID, MODEL_CATALOGUE, SUPPORTED_WIRES, inferenceProfileFor, isDrivable,
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

// Live failure, 2026-07-26: an agent on a non-Anthropic model failed with "The provided
// model identifier is invalid". The runner only ever spoke Anthropic's format, while the
// picker offered five models — so the catalogue could hand out a brain the engine can't
// drive. The wire format is now declared, and these hold that line.
describe("the catalogue never offers a model the engine can't drive", () => {
  it("marks every entry with the format it speaks", () => {
    for (const m of MODEL_CATALOGUE) {
      expect(["anthropic", "nova", "openai-compatible"]).toContain(m.wire);
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
