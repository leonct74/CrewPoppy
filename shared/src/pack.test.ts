import { describe, expect, it } from "vitest";
import { PACK_FORMAT, PACK_VERSION, describePackEdition, isPackModel, readCrewPack } from "./pack";

describe("the shared Crew Pack envelope", () => {
  it("reads a pack with care: the format, the version, the size — and keeps only objects", () => {
    expect(readCrewPack("nope")).toEqual({ error: "That is not a Crew Pack — expected a JSON object." });
    expect(readCrewPack({ format: "csv" })).toEqual({ error: 'That is not a Crew Pack — its format is "csv".' });
    expect(readCrewPack({ format: PACK_FORMAT, version: 9 })).toEqual({ error: "This Crew Pack is version 9; this CrewPoppy reads up to version 2. Update CrewPoppy first." });
    expect(readCrewPack({ format: PACK_FORMAT, version: "2" })).toMatchObject({ error: expect.stringContaining("version 2;") });
    expect(readCrewPack({ format: PACK_FORMAT, version: 2, agents: Array.from({ length: 101 }, () => ({})) })).toEqual({ error: "That pack holds 101 agents — the most a crew can take is 100." });
    expect(readCrewPack({ format: PACK_FORMAT, version: 2, notes: Array.from({ length: 1_500 }, () => ({})), files: Array.from({ length: 501 }, () => ({})) })).toEqual({ error: "That pack holds 2001 notes and files — more than 2000." });
    expect(readCrewPack({ format: PACK_FORMAT, version: 2, edition: "google", poppy: "com.crewpoppy.cloud.google", exportedAt: "2026-09-08T10:00:00.000Z", agents: [{ id: "emma" }, null, 4], notes: "x", files: [{ agent: "emma", path: "a.txt", content: "hi" }], omitted: ["report.pdf — over 5 MB", 7] })).toEqual({
      pack: { format: PACK_FORMAT, version: 2, exportedAt: "2026-09-08T10:00:00.000Z", edition: "google", poppy: "com.crewpoppy.cloud.google", agents: [{ id: "emma" }], notes: [], files: [{ agent: "emma", path: "a.txt", content: "hi" }], omitted: ["report.pdf — over 5 MB"] },
    });
    // An edition it does not know is read as the AWS edition's; a version-1 pack (the Google edition's own shape) is let through for that edition to convert.
    expect(readCrewPack({ format: PACK_FORMAT, version: 1, edition: "mars" })).toEqual({ pack: { format: PACK_FORMAT, version: 1, exportedAt: "", edition: "aws", poppy: "", agents: [], notes: [], files: [] } });
    expect(PACK_VERSION).toBe(2);
  });

  it("knows a model class and an edition's name", () => {
    expect(isPackModel("light")).toBe(true);
    expect(isPackModel("anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(false);
    expect(describePackEdition("aws")).toBe("the AWS edition");
    expect(describePackEdition("google")).toBe("the Google edition");
  });
});
