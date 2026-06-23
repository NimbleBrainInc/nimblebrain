/**
 * Tests for `scripts/lib/migrate-skill-frontmatter.ts` — the pure legacy →
 * canonical frontmatter transform behind `bun run migrate:skill-frontmatter`.
 *
 * The headline assertion: migrated CONTENT passes the SAME validator the
 * runtime loader uses (`validateFrontmatter`) and maps to the expected runtime
 * manifest (`mapFrontmatterToManifest`). That pins the migration to the real
 * contract, not a hand-rolled approximation of it.
 */

import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import {
  mapFrontmatterToManifest,
  validateFrontmatter,
} from "../../../src/skills/schemas/skill-manifest.ts";
import {
  migrateFrontmatterToManifest,
  migrateSkillContent,
} from "../../../scripts/lib/migrate-skill-frontmatter.ts";

describe("migrateFrontmatterToManifest", () => {
  test("`type: context` becomes loading-strategy always", () => {
    const m = migrateFrontmatterToManifest({
      name: "voice",
      description: "Voice rules",
      type: "context",
      priority: 20,
    });
    expect(m.loadingStrategy).toBe("always");
    expect(m.priority).toBe(20);
  });

  test("`type: skill` (or unset) becomes dynamic", () => {
    expect(
      migrateFrontmatterToManifest({ name: "a", description: "d", type: "skill" })
        .loadingStrategy,
    ).toBe("dynamic");
    expect(
      migrateFrontmatterToManifest({ name: "a", description: "d" }).loadingStrategy,
    ).toBe("dynamic");
  });

  test("legacy non-always strategies collapse to dynamic", () => {
    for (const s of ["tool_affined", "tool-affined", "retrieval", "explicit", "trigger"]) {
      expect(
        migrateFrontmatterToManifest({ name: "a", description: "d", loading_strategy: s })
          .loadingStrategy,
      ).toBe("dynamic");
    }
  });

  test("explicit loading-strategy: always wins over type: skill", () => {
    const m = migrateFrontmatterToManifest({
      name: "a",
      description: "d",
      type: "skill",
      "loading-strategy": "always",
    });
    expect(m.loadingStrategy).toBe("always");
  });

  test("applies-to-tools maps to tool-affinity; metadata.triggers carries over", () => {
    const m = migrateFrontmatterToManifest({
      name: "a",
      description: "d",
      "applies-to-tools": ["nb__*", "skills__create"],
      metadata: { triggers: ["do the thing"], keywords: ["thing", "do"] },
    });
    expect(m.toolAffinity).toEqual(["nb__*", "skills__create"]);
    expect(m.triggers).toEqual(["do the thing"]);
  });

  test("priority defaults to 50; status defaults to active and preserves disabled", () => {
    expect(migrateFrontmatterToManifest({ name: "a", description: "d" }).priority).toBe(50);
    expect(migrateFrontmatterToManifest({ name: "a", description: "d" }).status).toBe("active");
    expect(
      migrateFrontmatterToManifest({ name: "a", description: "d", status: "disabled" }).status,
    ).toBe("disabled");
  });

  test("drops version, type, requires-bundles, keywords, and scope", () => {
    const m = migrateFrontmatterToManifest({
      name: "a",
      description: "d",
      type: "skill",
      version: "1.0.0",
      scope: "org",
      "requires-bundles": ["@nonexistent/bundle"],
      metadata: { keywords: ["k1"], version: "2.0.0" },
    });
    expect(m.version).toBeUndefined();
    expect((m as Record<string, unknown>).type).toBeUndefined();
    expect((m as Record<string, unknown>)["requires-bundles"]).toBeUndefined();
    // scope is stamped from the directory tier at load, never persisted.
    expect(m.scope).toBeUndefined();
  });
});

describe("migrateSkillContent", () => {
  const LEGACY = [
    "---",
    "name: voice-rules",
    "description: Team voice",
    "version: 1.0.0",
    "type: skill",
    "priority: 30",
    "applies-to-tools:",
    "  - nb__*",
    "requires-bundles:",
    "  - '@nonexistent/bundle'",
    "metadata:",
    "  triggers:",
    "    - do the thing",
    "  keywords:",
    "    - thing",
    "---",
    "",
    "Body content here.",
    "",
  ].join("\n");

  test("migrated output validates against the canonical schema", () => {
    const { content, changed } = migrateSkillContent(LEGACY);
    expect(changed).toBe(true);

    const { data } = matter(content);
    const v = validateFrontmatter(data);
    expect(v.ok).toBe(true);
  });

  test("migrated output maps to the expected runtime manifest", () => {
    const { content } = migrateSkillContent(LEGACY);
    const { data } = matter(content);
    const v = validateFrontmatter(data);
    if (!v.ok) throw new Error(`expected valid frontmatter: ${v.errors.join(", ")}`);
    const m = mapFrontmatterToManifest(v.value);

    expect(m.name).toBe("voice-rules");
    expect(m.loadingStrategy).toBe("dynamic");
    expect(m.priority).toBe(30);
    expect(m.status).toBe("active");
    expect(m.toolAffinity).toEqual(["nb__*"]);
    expect(m.triggers).toEqual(["do the thing"]);
    expect(m.version).toBeUndefined();
  });

  test("preserves the body verbatim", () => {
    const { content } = migrateSkillContent(LEGACY);
    expect(content).toContain("Body content here.");
    expect(matter(content).content.trim()).toBe("Body content here.");
  });

  test("is idempotent — already-canonical content is left unchanged", () => {
    const once = migrateSkillContent(LEGACY);
    const twice = migrateSkillContent(once.content);
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
  });

  test("a fresh canonical file is detected as unchanged on first pass", () => {
    const canonical = [
      "---",
      "name: already-good",
      "description: Already canonical",
      "metadata:",
      "  nimblebrain:",
      "    loading-strategy: always",
      "    priority: 10",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const { changed } = migrateSkillContent(canonical);
    expect(changed).toBe(false);
  });
});
