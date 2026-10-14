import { describe, expect, it } from "bun:test";
import { looksLikeFrontmatter, skillEditPatch } from "../pages/settings/skill-edit-patch";

/**
 * The Skills editor sends one field per save, so each patch must name exactly
 * that field. The server side of this contract is exercised with these same
 * patches in test/unit/platform/skills/mutation.test.ts.
 */
describe("skillEditPatch", () => {
  const id = "/skills/voice.md";

  it("sends a manifest field alone, with no body", () => {
    expect(skillEditPatch(id, "loadingStrategy", "dynamic")).toEqual({
      id,
      manifest: { loadingStrategy: "dynamic" },
    });
    expect(skillEditPatch(id, "priority", " 40 ")).toEqual({ id, manifest: { priority: 40 } });
  });

  it("sends a list as its non-blank lines, and clears it with null", () => {
    expect(skillEditPatch(id, "triggers", "ship it\n\n  deploy  \n")).toEqual({
      id,
      manifest: { triggers: ["ship it", "deploy"] },
    });
    expect(skillEditPatch(id, "toolAffinity", "")).toEqual({
      id,
      manifest: { toolAffinity: null },
    });
    expect(skillEditPatch(id, "triggers", " \n\n ")).toEqual({ id, manifest: { triggers: null } });
  });

  it("refuses a priority outside the authorable band", () => {
    for (const bad of ["", "10", "100", "4.5", "abc"]) {
      expect(() => skillEditPatch(id, "priority", bad)).toThrow("11 to 99");
    }
  });

  it("sends the body as prose that no header in it can override a field with", () => {
    expect(skillEditPatch(id, "body", "  Be brief.  ")).toEqual({
      id,
      body: "Be brief.",
      body_mode: "replace",
      frontmatter: "ignore",
    });
  });

  it("holds a body that opens with a header unless it is kept as text", () => {
    const withHeader = "---\nname: voice\n---\n\nBe brief.";
    expect(() => skillEditPatch(id, "body", withHeader)).toThrow("header");
    expect(skillEditPatch(id, "body", withHeader, { keepHeaderAsText: true })).toMatchObject({
      body: withHeader,
      frontmatter: "ignore",
    });
  });

  it("refuses an empty body", () => {
    expect(() => skillEditPatch(id, "body", "   ")).toThrow("needs a body");
  });

  it("reads a header the way a save sends it: trimmed, trailing space allowed", () => {
    expect(looksLikeFrontmatter("\n---  \nname: x\n---\n")).toBe(true);
    expect(looksLikeFrontmatter("Body with --- inside.")).toBe(false);
  });
});
