import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveFeatures } from "../../src/config/features.ts";

/**
 * Drift guard: the published config schema must stay in lockstep with the
 * runtime's actual feature surface.
 *
 * `src/config/nimblebrain-config.schema.json` is the canonical source for
 * nimblebrain.json validation (the runtime compiles it with AJV at startup) and
 * is published to schemas.nimblebrain.ai by `.github/workflows/schema-deploy.yml`.
 * Its `features` object uses `additionalProperties: false`, so a flag added to
 * `FeatureFlags` but missing from the schema is rejected as an unknown key at
 * startup; a flag in the schema with no backing code is a dead knob. Both are
 * silent until someone hits them — this test turns the drift into a build
 * failure in the repo where the flag is authored.
 */
const schema = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../src/config/nimblebrain-config.schema.json"), "utf8"),
) as {
  properties: {
    features: { properties: Record<string, unknown>; additionalProperties: boolean };
  };
};

describe("config schema ↔ feature flags", () => {
  // resolveFeatures() with no argument returns the complete default set, so its
  // keys are the authoritative list of every feature flag the runtime knows.
  const runtimeKeys = Object.keys(resolveFeatures()).sort();
  const schemaKeys = Object.keys(schema.properties.features.properties).sort();

  test("every runtime feature flag is declared in the schema", () => {
    const missing = runtimeKeys.filter((k) => !schemaKeys.includes(k));
    expect(missing).toEqual([]);
  });

  test("every schema feature property has a backing runtime flag", () => {
    const extra = schemaKeys.filter((k) => !runtimeKeys.includes(k));
    expect(extra).toEqual([]);
  });

  test("the features object refuses unknown keys", () => {
    // The drift guard only holds if unknown keys are constrained; if this
    // flips to true, the two assertions above stop meaning anything.
    expect(schema.properties.features.additionalProperties).toBe(false);
  });
});
