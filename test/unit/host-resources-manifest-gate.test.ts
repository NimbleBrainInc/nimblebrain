import { describe, expect, it } from "bun:test";
import type { BundleManifest } from "../../src/bundles/types.ts";
import {
  assertHostCapabilitiesAvailable,
  HostManifestGateError,
} from "../../src/host-resources/index.ts";

// The install gate runs after manifest validation and before the bundle is
// registered. Its job is to refuse installs of bundles whose host-meta
// declares `required: true` for a capability this platform doesn't advertise.
//
// Shape: `_meta["ai.nimblebrain/host"].host_capabilities` is a keyed object
// `{ [vendorKey]: { required?: boolean } }`. Only entries with required:true
// are gated; everything else is "prefers but adapts" and the bundle handles
// runtime availability via SDK + structured tool errors (Level A + Level C).

function manifestWith(hostCapabilities?: Record<string, { required?: boolean }>): BundleManifest {
  return {
    manifest_version: "0.4",
    name: "test-bundle",
    display_name: "Test",
    version: "0.0.1",
    description: "fixture",
    author: { name: "test" },
    server: { type: "node", entry_point: "x", mcp_config: { command: "node", args: [] } },
    _meta: hostCapabilities
      ? {
          "ai.nimblebrain/host": {
            host_version: "1.1",
            host_capabilities: hostCapabilities,
          },
        }
      : undefined,
  } as unknown as BundleManifest;
}

describe("assertHostCapabilitiesAvailable", () => {
  it("is a no-op for a manifest without a host-meta block", () => {
    expect(() => assertHostCapabilitiesAvailable(manifestWith(), "x")).not.toThrow();
  });

  it("is a no-op when host_capabilities is empty", () => {
    expect(() => assertHostCapabilitiesAvailable(manifestWith({}), "x")).not.toThrow();
  });

  it("accepts a bundle that requires a provided capability", () => {
    expect(() =>
      assertHostCapabilitiesAvailable(
        manifestWith({ "ai.nimblebrain/host-resources": { required: true } }),
        "test-bundle",
      ),
    ).not.toThrow();
  });

  it("accepts a bundle that declares an unknown capability with required:false", () => {
    // Prefers-but-adapts. Platform need not provide it; bundle's runtime
    // fallback handles absence. Install must succeed.
    expect(() =>
      assertHostCapabilitiesAvailable(
        manifestWith({ "ai.nimblebrain/nonexistent": { required: false } }),
        "test-bundle",
      ),
    ).not.toThrow();
  });

  it("accepts a bundle that declares an unknown capability with required omitted", () => {
    // Omitted required defaults to false. Same semantics as explicit false.
    expect(() =>
      assertHostCapabilitiesAvailable(
        manifestWith({ "ai.nimblebrain/nonexistent": {} }),
        "test-bundle",
      ),
    ).not.toThrow();
  });

  it("refuses installs that require an unknown capability", () => {
    expect(() =>
      assertHostCapabilitiesAvailable(
        manifestWith({ "ai.nimblebrain/nonexistent": { required: true } }),
        "broken-bundle",
      ),
    ).toThrow(/broken-bundle/);
  });

  it("error message names the missing capability and the bundle", () => {
    let caught: Error | null = null;
    try {
      assertHostCapabilitiesAvailable(
        manifestWith({ "ai.nimblebrain/nonexistent": { required: true } }),
        "broken-bundle",
      );
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("broken-bundle");
    expect(caught?.message).toContain("ai.nimblebrain/nonexistent");
  });

  it("error message lists provided capabilities so operators can diagnose", () => {
    let caught: Error | null = null;
    try {
      assertHostCapabilitiesAvailable(
        manifestWith({ "ai.nimblebrain/nonexistent": { required: true } }),
        "broken-bundle",
      );
    } catch (e) {
      caught = e as Error;
    }
    // The user-facing message should hint at what IS available so a bundle
    // author who misnamed their key can spot the typo.
    expect(caught?.message).toContain("ai.nimblebrain/host-resources");
  });

  it("evaluates each entry independently — passes provided, fails missing", () => {
    expect(() =>
      assertHostCapabilitiesAvailable(
        manifestWith({
          "ai.nimblebrain/host-resources": { required: true },
          "ai.nimblebrain/nonexistent": { required: true },
        }),
        "mixed-bundle",
      ),
    ).toThrow(/ai\.nimblebrain\/nonexistent/);
  });

  it("ignores required:false entries even when paired with required:true that fails", () => {
    let caught: Error | null = null;
    try {
      assertHostCapabilitiesAvailable(
        manifestWith({
          "ai.nimblebrain/host-resources": { required: true },
          "ai.nimblebrain/optional-thing": { required: false },
          "ai.nimblebrain/nonexistent": { required: true },
        }),
        "mixed-bundle",
      );
    } catch (e) {
      caught = e as Error;
    }
    // Only the genuine missing+required item is named in the error.
    expect(caught?.message).toContain("ai.nimblebrain/nonexistent");
    expect(caught?.message).not.toContain("optional-thing");
  });

  // The gate runs JSON-Schema validation before the policy check — without
  // this, a typo'd `requierd: true` would be silently treated as
  // `required: false` and the bundle would install when it shouldn't.
  // These tests prove the schema is actually enforced at the gate, not
  // just exercised by a standalone schema test.

  it("rejects manifests whose host-meta block fails schema validation (typo'd field)", () => {
    const bad: BundleManifest = {
      manifest_version: "0.4",
      name: "typo-bundle",
      display_name: "Typo",
      version: "0.0.1",
      description: "fixture",
      author: { name: "test" },
      server: { type: "node", entry_point: "x", mcp_config: { command: "node", args: [] } },
      _meta: {
        "ai.nimblebrain/host": {
          host_version: "1.1",
          host_capabilities: {
            "ai.nimblebrain/host-resources": { required: true, oops: "typo" } as unknown,
          },
        },
      },
    } as unknown as BundleManifest;

    expect(() => assertHostCapabilitiesAvailable(bad, "typo-bundle")).toThrow(/invalid/i);
  });

  it("tolerates host_capabilities paired with host_version 1.0 (version↔capability is advisory, not gated)", () => {
    // Previously the schema's if/then hard-rejected this pairing. That if/then was
    // dropped with the tolerance relaxation — forcing an exact version conflicts with
    // forward-compat (a 1.2 bundle with host_capabilities would have failed). The
    // "host_capabilities needs >= 1.1" rule is now documentation, not a hard gate.
    const m: BundleManifest = {
      manifest_version: "0.4",
      name: "version-mismatch",
      display_name: "Mismatch",
      version: "0.0.1",
      description: "fixture",
      author: { name: "test" },
      server: { type: "node", entry_point: "x", mcp_config: { command: "node", args: [] } },
      _meta: {
        "ai.nimblebrain/host": {
          host_version: "1.0",
          host_capabilities: { "ai.nimblebrain/host-resources": { required: true } },
        },
      },
    } as unknown as BundleManifest;

    // host-resources IS provided, so no capability-unavailable throw; and the
    // version pairing is no longer schema-invalid.
    expect(() => assertHostCapabilitiesAvailable(m, "version-mismatch")).not.toThrow();
  });
});

// The boot/re-spawn self-heal in startBundleSource catches gate failures by
// `instanceof HostManifestGateError` (and only force-refreshes on those), so
// the typed error + its `reason` discriminator are a load-bearing contract.
// The human-readable message must stay byte-compatible with the old `Error`
// form so existing log/assert call sites don't regress.
describe("HostManifestGateError", () => {
  // Schema-invalid is the stale-cache incident shape: a cached manifest whose
  // host-meta fails validation (e.g. a briefing.priority not in the enum).
  it("throws HostManifestGateError with reason=schema-invalid for a bad host-meta block", () => {
    const bad = {
      manifest_version: "0.4",
      name: "schema-bad",
      version: "0.0.1",
      description: "fixture",
      author: { name: "test" },
      server: { type: "node", entry_point: "x", mcp_config: { command: "node", args: [] } },
      _meta: {
        "ai.nimblebrain/host": {
          host_version: "1.1",
          host_capabilities: { "ai.nimblebrain/host-resources": { required: true, oops: "x" } },
        },
      },
    } as unknown as BundleManifest;

    let caught: unknown;
    try {
      assertHostCapabilitiesAvailable(bad, "schema-bad");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HostManifestGateError);
    const err = caught as HostManifestGateError;
    expect(err.reason).toBe("schema-invalid");
    expect(err.bundleName).toBe("schema-bad");
    expect(err.message).toContain("Refusing to install");
  });

  it("throws HostManifestGateError with reason=capability-unavailable for a missing required capability", () => {
    let caught: unknown;
    try {
      assertHostCapabilitiesAvailable(
        manifestWith({ "ai.nimblebrain/nonexistent": { required: true } }),
        "cap-bad",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HostManifestGateError);
    const err = caught as HostManifestGateError;
    expect(err.reason).toBe("capability-unavailable");
    expect(err.bundleName).toBe("cap-bad");
    expect(err.message).toContain("Refusing to install");
  });
});

// Build a manifest with an arbitrary ai.nimblebrain/host block (untrusted shape).
function manifestWithHost(host: unknown): BundleManifest {
  return {
    manifest_version: "0.4",
    name: "tol-bundle",
    display_name: "Tol",
    version: "0.0.1",
    description: "fixture",
    author: { name: "test" },
    server: { type: "node", entry_point: "x", mcp_config: { command: "node", args: [] } },
    _meta: { "ai.nimblebrain/host": host },
  } as unknown as BundleManifest;
}

// The published v1 contract's "tolerance lock": the gate must NOT hard-fail on an
// unknown host_version or unknown top-level keys (forward-compat for a contract
// third parties copy), but MUST stay strict where a typo is dangerous — inside a
// host_capabilities requirement, where it would silently downgrade a security gate.
describe("host-meta gate — tolerance lock (forward-compatible)", () => {
  it("tolerates an unknown host_version (does not hard-fail)", () => {
    expect(() =>
      assertHostCapabilitiesAvailable(
        manifestWithHost({ host_version: "1.2", name: "X" }),
        "tol-bundle",
      ),
    ).not.toThrow();
  });

  it("tolerates unknown top-level keys (ignored, not rejected)", () => {
    expect(() =>
      assertHostCapabilitiesAvailable(
        manifestWithHost({ host_version: "1.1", name: "X", some_future_key: { a: 1 } }),
        "tol-bundle",
      ),
    ).not.toThrow();
  });

  it("still REJECTS a typo inside a host_capabilities requirement (security-sensitive)", () => {
    expect(() =>
      assertHostCapabilitiesAvailable(
        // `requierd` instead of `required` — must not silently pass as prefers-but-adapts
        manifestWithHost({
          host_version: "1.1",
          host_capabilities: { "ai.nimblebrain/host-resources": { requierd: true } },
        }),
        "tol-bundle",
      ),
    ).toThrow(HostManifestGateError);
  });
});
