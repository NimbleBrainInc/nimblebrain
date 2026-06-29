import { describe, expect, it } from "bun:test";
import { validateManifest } from "../../../src/bundles/manifest.ts";

// Pure-logic coverage for the manifest validator's accept/reject branches.
// No filesystem or network: the validator runs on every local-bundle startup
// (src/bundles/startup.ts), but the startup/lifecycle integration tests only
// hit the failures that occur *before* validation (corrupt JSON, missing file)
// or feed it a structurally valid manifest — so these branches are exercised
// nowhere else.
describe("validateManifest", () => {
  it("accepts a structurally valid 0.4 manifest", () => {
    const result = validateManifest({
      manifest_version: "0.4",
      name: "@test/valid",
      version: "1.0.0",
      description: "A valid bundle",
      author: { name: "Test Author" },
      server: {
        type: "node",
        entry_point: "index.js",
        mcp_config: { command: "node", args: ["${__dirname}/index.js"] },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.version).toBe("0.4");
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.name).toBe("@test/valid");
  });

  it("rejects manifests with missing version", () => {
    const result = validateManifest({ name: "test", version: "1.0" });
    expect(result.valid).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.errors[0]).toContain("Missing manifest_version");
  });

  it("rejects manifests with unsupported version", () => {
    const result = validateManifest({ manifest_version: "0.1", name: "test" });
    expect(result.valid).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.errors[0]).toContain("Unsupported");
  });

  it("rejects manifests missing required fields", () => {
    const result = validateManifest({ manifest_version: "0.4", name: "test" });
    expect(result.valid).toBe(false);
    expect(result.manifest).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
