/**
 * Canonical skill-manifest schema: validation + the on-disk → runtime mapper.
 */

import { describe, expect, test } from "bun:test";
import {
  mapFrontmatterToManifest,
  type SkillFrontmatter,
  validateFrontmatter,
} from "../../../src/skills/schemas/skill-manifest.ts";

describe("validateFrontmatter", () => {
  test("accepts a minimal pristine-standard skill", () => {
    const r = validateFrontmatter({ name: "gmail-usage", description: "Use Gmail." });
    expect(r.ok).toBe(true);
  });

  test("accepts the full runtime shape (metadata.nimblebrain.*)", () => {
    const r = validateFrontmatter({
      name: "gmail-usage",
      description: "Use Gmail.",
      "allowed-tools": "gmail__send gmail__search",
      metadata: {
        author: "nimblebrain",
        version: "1.0",
        nimblebrain: {
          "loading-strategy": "dynamic",
          priority: 60,
          status: "active",
          "tool-affinity": ["gmail__*"],
          triggers: ["draft an email"],
          provenance: { origin: "connector", "created-by": "usr_x" },
        },
      },
    });
    expect(r.ok).toBe(true);
  });

  test.each([
    ["uppercase name", { name: "Gmail", description: "x" }],
    ["underscore name", { name: "g_mail", description: "x" }],
    ["consecutive hyphens", { name: "g--mail", description: "x" }],
    ["empty description", { name: "gmail", description: "" }],
    ["unknown top-level key", { name: "gmail", description: "x", type: "skill" }],
  ])("rejects %s", (_label, data) => {
    expect(validateFrontmatter(data).ok).toBe(false);
  });

  test("rejects a nimblebrain block missing loading-strategy", () => {
    const r = validateFrontmatter({
      name: "gmail",
      description: "x",
      metadata: { nimblebrain: { priority: 50 } },
    });
    expect(r.ok).toBe(false);
  });

  test("rejects an unknown nimblebrain key (strict extension)", () => {
    const r = validateFrontmatter({
      name: "gmail",
      description: "x",
      metadata: { nimblebrain: { "loading-strategy": "dynamic", type: "skill" } },
    });
    expect(r.ok).toBe(false);
  });

  test("surfaces error paths for fail-soft logging", () => {
    const r = validateFrontmatter({ name: "Bad", description: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("mapFrontmatterToManifest", () => {
  test("defaults a pristine source (no nimblebrain block) to dynamic/50/active", () => {
    const fm = { name: "gmail", description: "x" } as SkillFrontmatter;
    const m = mapFrontmatterToManifest(fm);
    expect(m.loadingStrategy).toBe("dynamic");
    expect(m.priority).toBe(50);
    expect(m.status).toBe("active");
    expect(m.toolAffinity).toBeUndefined();
  });

  test("flattens nested NB config to the runtime shape", () => {
    const fm = {
      name: "gmail",
      description: "x",
      "allowed-tools": "gmail__send gmail__search",
      metadata: {
        author: "nb",
        version: "1.0",
        nimblebrain: {
          "loading-strategy": "dynamic",
          priority: 60,
          status: "active",
          "tool-affinity": ["gmail__*"],
          triggers: ["draft an email"],
        },
      },
    } as SkillFrontmatter;
    const m = mapFrontmatterToManifest(fm, { scope: "workspace" });
    expect(m.loadingStrategy).toBe("dynamic");
    expect(m.priority).toBe(60);
    expect(m.toolAffinity).toEqual(["gmail__*"]);
    expect(m.triggers).toEqual(["draft an email"]);
    expect(m.allowedTools).toEqual(["gmail__send", "gmail__search"]); // space-string → array
    expect(m.author).toBe("nb");
    expect(m.version).toBe("1.0");
    expect(m.scope).toBe("workspace");
  });

  test("maps provenance kebab → camel", () => {
    const fm = {
      name: "gmail",
      description: "x",
      metadata: {
        nimblebrain: {
          "loading-strategy": "always",
          provenance: {
            origin: "chat",
            "conversation-id": "conv_abc",
            "created-by": "usr_x",
            "created-at": "2026-06-23T17:50:00Z",
            "updated-at": "2026-06-23T18:00:00Z",
          },
        },
      },
    } as SkillFrontmatter;
    const m = mapFrontmatterToManifest(fm);
    expect(m.loadingStrategy).toBe("always");
    expect(m.provenance).toEqual({
      origin: "chat",
      conversationId: "conv_abc",
      createdBy: "usr_x",
      createdAt: "2026-06-23T17:50:00Z",
      updatedAt: "2026-06-23T18:00:00Z",
    });
  });
});
