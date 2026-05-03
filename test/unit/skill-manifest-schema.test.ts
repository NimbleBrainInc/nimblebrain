/**
 * Tests for `src/skills/schemas/manifest.ts` — the on-disk skill manifest
 * schema. Verifies that representative writer outputs and edge cases
 * pass schema validation, plus negative tests proving structural
 * constraints (name pattern, priority bounds, scope enum).
 */
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import { SkillManifestOnDisk } from "../../src/skills/schemas/manifest.ts";

describe("SkillManifestOnDisk", () => {
  test("accepts a minimal valid manifest", () => {
    const manifest = {
      name: "foo",
      description: "A short description",
      version: "1.0.0",
      type: "skill",
      priority: 50,
    };
    expect(Value.Check(SkillManifestOnDisk, manifest)).toBe(true);
  });

  test("accepts a fully-populated manifest with operator-only fields", () => {
    const manifest = {
      name: "kitchen-sink",
      description: "Has every field set",
      version: "2.1.3",
      type: "context",
      priority: 99,
      allowedTools: ["echo__*", "files__*"],
      requiresBundles: ["echo"],
      metadata: {
        keywords: ["kitchen", "sink"],
        triggers: ["test"],
        category: "test",
        tags: ["a", "b"],
        author: "tester",
        created_at: "2026-05-01T00:00:00Z",
        source: "test",
      },
      scope: "workspace",
      loadingStrategy: "tool_affined",
      appliesToTools: ["echo__*"],
      status: "active",
      overrides: [{ bundle: "old-bundle", reason: "deprecated" }],
      derivedFrom: "skill://parent/template",
    };
    expect(Value.Check(SkillManifestOnDisk, manifest)).toBe(true);
  });

  test("rejects a manifest with invalid name characters", () => {
    expect(
      Value.Check(SkillManifestOnDisk, {
        name: "has spaces",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 50,
      }),
    ).toBe(false);
  });

  test("rejects priority outside 0-100", () => {
    expect(
      Value.Check(SkillManifestOnDisk, {
        name: "foo",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 101,
      }),
    ).toBe(false);
  });

  test("rejects unknown scope value", () => {
    expect(
      Value.Check(SkillManifestOnDisk, {
        name: "foo",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        scope: "everywhere",
      }),
    ).toBe(false);
  });

  test("rejects missing required field (description)", () => {
    expect(
      Value.Check(SkillManifestOnDisk, {
        name: "foo",
        version: "1.0.0",
        type: "skill",
        priority: 50,
      }),
    ).toBe(false);
  });

  test("metadata.keywords and triggers required when metadata present", () => {
    expect(
      Value.Check(SkillManifestOnDisk, {
        name: "foo",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        metadata: { category: "no-keywords-or-triggers" },
      }),
    ).toBe(false);
  });
});
