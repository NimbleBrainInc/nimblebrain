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

  it("rejects a v1.0 manifest that declares host_capabilities", () => {
    const result = validateHostMeta({
      "ai.nimblebrain/host": {
        host_version: "1.0",
        host_capabilities: { "ai.nimblebrain/host-resources": { required: true } },
      },
    });
    expect(result.valid).toBe(false);
    // The mismatched-version error mentions host_version.
    expect(result.errors.join(" ")).toMatch(/host_version/);
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
