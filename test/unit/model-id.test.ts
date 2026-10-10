import { describe, expect, test } from "bun:test";
import {
  isQualifiedModelId,
  ModelNotQualifiedError,
  requireQualifiedModelId,
  unqualifiedModelIdError,
} from "../../src/model/model-id.ts";

describe("isQualifiedModelId", () => {
  test.each([
    "anthropic:claude-sonnet-4-6",
    "google:gemini-2.5-flash",
    "nebius:openai/gpt-oss-120b",
    "openai:ft:gpt-4o:my-org",
  ])("accepts %s", (id) => {
    expect(isQualifiedModelId(id)).toBe(true);
  });

  test.each(["claude-sonnet-4-6", "", ":claude-sonnet-4-6", "anthropic:"])("refuses %p", (id) => {
    expect(isQualifiedModelId(id)).toBe(false);
  });
});

describe("unqualifiedModelIdError", () => {
  test("is null for a qualified id", () => {
    expect(unqualifiedModelIdError("anthropic:claude-sonnet-4-6")).toBeNull();
  });

  // The refusal is only useful if it says what to write instead, and the
  // catalog knows which provider serves a catalogued vendor id.
  test.each([
    ["claude-sonnet-4-6", "anthropic:claude-sonnet-4-6"],
    ["gemini-2.5-flash", "google:gemini-2.5-flash"],
    ["gpt-4o", "openai:gpt-4o"],
  ])("names the qualified form of catalogued %s", (bare, qualified) => {
    expect(unqualifiedModelIdError(bare)).toContain(`"${qualified}"`);
  });

  // Guessing a provider for an id the catalog lacks is what the rule exists to
  // stop, so the suggestion keeps the provider a placeholder.
  test("does not guess a provider for an uncatalogued id", () => {
    const msg = unqualifiedModelIdError("custom-fine-tune");
    expect(msg).toContain('"<provider>:custom-fine-tune"');
    expect(msg).not.toContain("anthropic:");
  });

  test("names the field it was given", () => {
    expect(unqualifiedModelIdError("claude-sonnet-4-6", "models.fast")).toStartWith(
      'models.fast "claude-sonnet-4-6" has no provider.',
    );
  });
});

describe("requireQualifiedModelId", () => {
  test("returns a qualified id unchanged", () => {
    expect(requireQualifiedModelId("xai:grok-4.5")).toBe("xai:grok-4.5");
  });

  test("throws ModelNotQualifiedError carrying the id", () => {
    try {
      requireQualifiedModelId("claude-sonnet-4-6");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotQualifiedError);
      expect((err as ModelNotQualifiedError).model).toBe("claude-sonnet-4-6");
      expect((err as ModelNotQualifiedError).code).toBe("model_not_qualified");
    }
  });
});
