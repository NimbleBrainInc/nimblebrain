/**
 * Tests for `resolveLoadingMechanism` — the shared predicate that decides how a
 * skill reaches the model.
 */

import { describe, expect, test } from "bun:test";
import { resolveLoadingMechanism } from "../../../src/skills/loading.ts";
import type { SkillLoadingStrategy, SkillManifest } from "../../../src/skills/types.ts";

interface ManifestOptions {
  loadingStrategy?: SkillLoadingStrategy;
  toolAffinity?: string[];
  triggers?: string[];
}

function makeManifest(opts: ManifestOptions = {}): SkillManifest {
  return {
    name: "fixture",
    description: "fixture description",
    loadingStrategy: opts.loadingStrategy ?? "dynamic",
    priority: 50,
    status: "active",
    ...(opts.toolAffinity ? { toolAffinity: opts.toolAffinity } : {}),
    ...(opts.triggers ? { triggers: opts.triggers } : {}),
  };
}

describe("resolveLoadingMechanism", () => {
  test("dynamic with no affinity or triggers loads on request, from the catalog", () => {
    const m = makeManifest({ loadingStrategy: "dynamic" });
    expect(resolveLoadingMechanism(m)).toBe("on_request");
  });

  test("an explicit empty tool-affinity binds no tool, so it loads on request", () => {
    const m = makeManifest({ loadingStrategy: "dynamic", toolAffinity: [] });
    expect(resolveLoadingMechanism(m)).toBe("on_request");
  });

  test("dynamic + triggers loads via the matcher", () => {
    const m = makeManifest({ loadingStrategy: "dynamic", triggers: ["deploy the widget"] });
    expect(resolveLoadingMechanism(m)).toBe("trigger");
  });

  test("dynamic + tool-affinity resolves to tool affinity", () => {
    const m = makeManifest({ loadingStrategy: "dynamic", toolAffinity: ["nb__*"] });
    expect(resolveLoadingMechanism(m)).toBe("tool_affinity");
  });

  test("always composes into the context channel", () => {
    const m = makeManifest({ loadingStrategy: "always" });
    expect(resolveLoadingMechanism(m)).toBe("always");
  });

  test("always wins over affinity/triggers (precedence)", () => {
    const m = makeManifest({
      loadingStrategy: "always",
      toolAffinity: ["nb__*"],
      triggers: ["x"],
    });
    expect(resolveLoadingMechanism(m)).toBe("always");
  });

  test("tool-affinity takes precedence over triggers", () => {
    const m = makeManifest({
      loadingStrategy: "dynamic",
      toolAffinity: ["nb__*"],
      triggers: ["x"],
    });
    expect(resolveLoadingMechanism(m)).toBe("tool_affinity");
  });
});
