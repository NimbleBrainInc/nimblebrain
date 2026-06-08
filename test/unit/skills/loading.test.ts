/**
 * Tests for `resolveLoadingMechanism` / `wouldLoad` — the shared predicate
 * that decides whether a skill is reachable by any loader path.
 *
 * Pure-function tests over real `SkillManifest` fixtures. They assert the
 * classification a known-dead vs known-live manifest receives, matching the
 * real loader/selector/matcher behavior.
 */

import { describe, expect, test } from "bun:test";
import { resolveLoadingMechanism, wouldLoad } from "../../../src/skills/loading.ts";
import type { SkillLoadingStrategy, SkillManifest, SkillType } from "../../../src/skills/types.ts";

interface ManifestOptions {
  type?: SkillType;
  loadingStrategy?: SkillLoadingStrategy;
  appliesToTools?: string[];
  triggers?: string[];
  keywords?: string[];
}

function makeManifest(opts: ManifestOptions = {}): SkillManifest {
  return {
    name: "fixture",
    description: "fixture description",
    version: "1.0.0",
    type: opts.type ?? "skill",
    priority: 50,
    ...(opts.loadingStrategy ? { loadingStrategy: opts.loadingStrategy } : {}),
    ...(opts.appliesToTools ? { appliesToTools: opts.appliesToTools } : {}),
    ...(opts.triggers || opts.keywords
      ? {
          metadata: {
            keywords: opts.keywords ?? [],
            triggers: opts.triggers ?? [],
          },
        }
      : {}),
  };
}

describe("resolveLoadingMechanism", () => {
  test("a type:skill with no strategy, triggers, keywords, or affinity is dead", () => {
    const m = makeManifest({ type: "skill" });
    expect(resolveLoadingMechanism(m)).toBe("none");
    expect(wouldLoad(m)).toBe(false);
  });

  test("a type:skill with triggers loads via the matcher", () => {
    const m = makeManifest({ type: "skill", triggers: ["deploy the widget"] });
    expect(resolveLoadingMechanism(m)).toBe("trigger");
    expect(wouldLoad(m)).toBe(true);
  });

  test("a type:skill with keywords (no triggers) loads via the matcher", () => {
    const m = makeManifest({ type: "skill", keywords: ["alpha", "beta"] });
    expect(resolveLoadingMechanism(m)).toBe("trigger");
  });

  test("a type:context with nothing else always composes", () => {
    const m = makeManifest({ type: "context" });
    expect(resolveLoadingMechanism(m)).toBe("always");
    expect(wouldLoad(m)).toBe(true);
  });

  test("applies-to-tools resolves to tool affinity", () => {
    const m = makeManifest({ type: "skill", appliesToTools: ["nb__*"] });
    expect(resolveLoadingMechanism(m)).toBe("tool_affinity");
  });

  test("explicit loading-strategy:always wins over an otherwise-dead type:skill", () => {
    const m = makeManifest({ type: "skill", loadingStrategy: "always" });
    expect(resolveLoadingMechanism(m)).toBe("always");
  });

  test("explicit loading-strategy:tool_affined resolves to tool affinity", () => {
    const m = makeManifest({ type: "skill", loadingStrategy: "tool_affined" });
    expect(resolveLoadingMechanism(m)).toBe("tool_affinity");
  });

  test("retrieval strategy does not load today (not yet enforced by select.ts)", () => {
    const m = makeManifest({ type: "skill", loadingStrategy: "retrieval" });
    expect(resolveLoadingMechanism(m)).toBe("none");
    expect(wouldLoad(m)).toBe(false);
  });

  test("explicit strategy does not load today", () => {
    const m = makeManifest({ type: "skill", loadingStrategy: "explicit" });
    expect(resolveLoadingMechanism(m)).toBe("none");
  });

  test("a retrieval-strategy skill that ALSO has triggers still loads via the matcher", () => {
    const m = makeManifest({
      type: "skill",
      loadingStrategy: "retrieval",
      triggers: ["do the thing"],
    });
    expect(resolveLoadingMechanism(m)).toBe("trigger");
  });
});
