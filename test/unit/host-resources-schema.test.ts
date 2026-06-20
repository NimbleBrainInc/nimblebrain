import { describe, expect, it } from "bun:test";
import { validateHostMeta } from "../../src/bundles/manifest.ts";

// Schema-level invariants for `_meta["ai.nimblebrain/host"]`. We added an
// `if/then` so manifests declaring `host_capabilities` MUST set
// `host_version: "1.1"` — otherwise a v1.0-labeled manifest could use a
// v1.1-only field and lie about its schema version. The runtime gate
// doesn't read `host_version` directly; this schema check is the only
// place keeping that promise honest.

describe("host-manifest schema", () => {
  it("accepts a v1.0 manifest with no host_capabilities", () => {
    const result = validateHostMeta({ "ai.nimblebrain/host": { host_version: "1.0" } });
    expect(result.valid).toBe(true);
  });

  it("accepts a v1.1 manifest with host_capabilities present", () => {
    const result = validateHostMeta({
      "ai.nimblebrain/host": {
        host_version: "1.1",
        host_capabilities: { "ai.nimblebrain/host-resources": { required: true } },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a v1.1 manifest with no host_capabilities (forward-compat label)", () => {
    const result = validateHostMeta({ "ai.nimblebrain/host": { host_version: "1.1" } });
    expect(result.valid).toBe(true);
  });

  it("tolerance lock: unknown host_version + unknown top-level keys validate (forward-compat)", () => {
    // The published v1 contract must not hard-fail a newer version or a future field —
    // the host parses what it understands and ignores the rest. (Root is
    // additionalProperties:true and host_version is an open string.)
    expect(
      validateHostMeta({
        "ai.nimblebrain/host": { host_version: "1.2", name: "X", some_future_key: { a: 1 } },
      }).valid,
    ).toBe(true);
    // The version↔capability pairing is advisory now (the if/then was dropped), so
    // host_capabilities on a 1.0 label no longer fails schema validation.
    expect(
      validateHostMeta({
        "ai.nimblebrain/host": {
          host_version: "1.0",
          host_capabilities: { "ai.nimblebrain/host-resources": { required: true } },
        },
      }).valid,
    ).toBe(true);
  });

  it("rejects a host_capabilities entry with unknown fields", () => {
    // additionalProperties:false on HostCapabilityRequirement protects the
    // shape from typo'd or speculative fields (e.g. `requierd: true`).
    const result = validateHostMeta({
      "ai.nimblebrain/host": {
        host_version: "1.1",
        host_capabilities: {
          "ai.nimblebrain/host-resources": { required: true, oops: "typo" },
        },
      },
    });
    expect(result.valid).toBe(false);
  });

  it("accepts an empty host_capabilities map on v1.1 (no-op declaration)", () => {
    const result = validateHostMeta({
      "ai.nimblebrain/host": { host_version: "1.1", host_capabilities: {} },
    });
    expect(result.valid).toBe(true);
  });
});
