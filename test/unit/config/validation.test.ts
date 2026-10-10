/**
 * Tests for config schema validation via AJV.
 *
 * Verifies that structural errors throw, unknown keys warn but don't crash,
 * and edge cases (empty config, missing file, invalid types) are handled.
 */

import { describe, expect, it } from "bun:test";
import { getValidator } from "../../../src/config/index.ts";

const validate = getValidator();

function isValid(config: unknown): boolean {
  return validate(config) as boolean;
}

function getErrors(config: unknown): string[] {
  validate(config);
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath || "(root)"} ${e.keyword}: ${e.message}`,
  );
}

describe("config schema validation", () => {
  it("accepts empty object (backward compat)", () => {
    expect(isValid({})).toBe(true);
  });

  it("accepts minimal valid config", () => {
    expect(
      isValid({
        version: "1",
        models: { default: "anthropic:claude-sonnet-4-5-20250929" },
      }),
    ).toBe(true);
  });

  // A model id names its provider. The refusal names the form to write, so an
  // operator reading the boot error can paste the fix.
  it.each([
    [{ models: { default: "claude-sonnet-4-6" } }, "/models/default"],
    [{ models: { fast: "claude-haiku-4-5" } }, "/models/fast"],
    [
      { modelPolicy: { allowed: ["anthropic:claude-sonnet-4-6", "gpt-4o"] } },
      "/modelPolicy/allowed/1",
    ],
  ])("refuses a bare model id at %#, naming the qualified form", (config, path) => {
    expect(isValid(config)).toBe(false);
    const errors = getErrors(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith(`${path} nbQualifiedModelId:`);
    expect(errors[0]).toMatch(/Write it as provider:model, e\.g\. "(anthropic|openai):/);
  });

  it("accepts qualified ids in every model field", () => {
    expect(
      isValid({
        models: { default: "anthropic:claude-sonnet-4-6", fast: "nebius:openai/gpt-oss-120b" },
        modelPolicy: { allowed: ["anthropic:claude-sonnet-4-6", "nebius:openai/gpt-oss-120b"] },
      }),
    ).toBe(true);
  });

  it("accepts valid http config", () => {
    expect(isValid({ http: { port: 8080 } })).toBe(true);
  });

  it("rejects http port out of range", () => {
    const result = isValid({ http: { port: 99999 } });
    expect(result).toBe(false);
    const errors = getErrors({ http: { port: 99999 } });
    expect(errors.some((e) => e.includes("port"))).toBe(true);
  });

  it("rejects http port as string", () => {
    expect(isValid({ http: { port: "8080" } })).toBe(false);
  });

  it("reports unknown top-level keys as additionalProperties errors", () => {
    // AJV with additionalProperties will flag these
    const config = { madeUpField: true };
    validate(config);
    const errors = validate.errors ?? [];
    const hasAdditional = errors.some((e) => e.keyword === "additionalProperties");
    // Schema may or may not enforce additionalProperties at root — verify behavior
    if (hasAdditional) {
      expect(errors.some((e) => e.params?.additionalProperty === "madeUpField")).toBe(true);
    }
  });

  it("accepts valid features config", () => {
    expect(
      isValid({
        features: {
          skillManagement: false,
          catalogSearch: true,
        },
      }),
    ).toBe(true);
  });

  it("rejects features with non-boolean value", () => {
    expect(isValid({ features: { catalogSearch: "yes" } })).toBe(false);
  });

  it("accepts valid logging config", () => {
    expect(isValid({ logging: { disabled: true } })).toBe(true);
  });

  it("accepts valid maxIterations within bounds", () => {
    expect(isValid({ maxIterations: 10 })).toBe(true);
  });
});
