/**
 * What the override file is allowed to carry.
 *
 * `nimblebrain.overrides.json` sits on the PVC, survives every deploy, and
 * outranks the Helm-managed seed. That is correct for the handful of fields
 * `set_model_config` writes — and a trap for anything else, because a key with
 * no writer can never be cleared. It would layer over the seed on every boot
 * with the deployment's own configuration unable to reclaim it.
 *
 * The module header has always stated that the file holds only writable
 * fields. These tests are what makes the statement true.
 */

import { describe, expect, it } from "bun:test";
import { OVERRIDE_WRITABLE_KEYS, mergeConfigs } from "../../../src/config/overrides.ts";

describe("mergeConfigs", () => {
  it("lets a writable field override the seed", () => {
    const merged = mergeConfigs(
      { maxIterations: 10, models: { default: "a", fast: "b" } },
      { maxIterations: 25, models: { fast: "c" } },
    );
    expect(merged.maxIterations).toBe(25);
    // Objects merge key-by-key, so overriding `fast` keeps the seed's `default`.
    expect(merged.models).toEqual({ default: "a", fast: "c" });
  });

  it("drops a field no writer can clear", () => {
    // The failure this prevents: a field written while it was still settable,
    // then made deployment-only. Kept, it outranks the seed forever.
    const merged = mergeConfigs(
      { modelPolicy: { allowed: ["anthropic:claude-sonnet-5"] }, maxIterations: 10 },
      { modelPolicy: { allowed: ["anthropic:claude-opus-5"] }, maxIterations: 25 },
    );
    expect(merged.modelPolicy).toEqual({ allowed: ["anthropic:claude-sonnet-5"] });
    expect(merged.maxIterations).toBe(25);
  });

  it("drops an unknown key rather than layering it", () => {
    const merged = mergeConfigs({ providers: { anthropic: {} } }, { providers: {}, nonsense: 1 });
    // `providers` is operator config and belongs to the seed alone.
    expect(merged.providers).toEqual({ anthropic: {} });
    expect(merged.nonsense).toBeUndefined();
  });

  it("leaves the seed alone when the override is empty", () => {
    const seed = { maxIterations: 10, models: { default: "a" } };
    expect(mergeConfigs(seed, {})).toEqual(seed);
  });
});
