/**
 * Unit tests for the server-skill adapter (SEP-2640 `io.modelcontextprotocol/skills`).
 *
 * The pure functions — `isSkillEntrypointUri`, `parseSkillMarkdown`, and
 * `synthesizeBundleSkill` — are the discovery + synthesis primitives the runtime
 * composes. Combined with `selectLayer3Skills`, we verify end-to-end selection
 * behavior (active toolset → skill loads) without spinning up a Runtime.
 */

import { describe, expect, test } from "bun:test";
import {
  isSkillEntrypointUri,
  parseSkillMarkdown,
  synthesizeBundleSkill,
} from "../../../src/skills/bundle-skills.ts";
import { selectLayer3Skills } from "../../../src/skills/select.ts";

describe("isSkillEntrypointUri", () => {
  test("matches skill:// URIs ending in /SKILL.md, flat and nested", () => {
    expect(isSkillEntrypointUri("skill://foo/SKILL.md")).toBe(true);
    expect(isSkillEntrypointUri("skill://acme/billing/refunds/SKILL.md")).toBe(true);
  });

  test("rejects the legacy /usage convention, supporting files, and other schemes", () => {
    expect(isSkillEntrypointUri("skill://foo/usage")).toBe(false);
    expect(isSkillEntrypointUri("skill://foo/SKILL.md/extra")).toBe(false);
    expect(isSkillEntrypointUri("skill://foo/scripts/helper.py")).toBe(false);
    expect(isSkillEntrypointUri("file:///x/SKILL.md")).toBe(false);
    expect(isSkillEntrypointUri("skill://SKILL.md")).toBe(false);
  });
});

describe("parseSkillMarkdown", () => {
  test("extracts name + description from frontmatter and strips it from the body", () => {
    const raw = "---\nname: refunds\ndescription: How to process refunds.\n---\n\n# Refunds\n\nBody.";
    const parsed = parseSkillMarkdown("skill://acme/billing/refunds/SKILL.md", raw);
    expect(parsed.name).toBe("refunds");
    expect(parsed.description).toBe("How to process refunds.");
    expect(parsed.body).toContain("# Refunds");
    expect(parsed.body).not.toContain("description:");
  });

  test("falls back to the final skill-path segment when frontmatter omits name", () => {
    const parsed = parseSkillMarkdown("skill://acme/billing/refunds/SKILL.md", "# no frontmatter");
    expect(parsed.name).toBe("refunds");
    expect(parsed.description).toBe("");
    expect(parsed.body).toContain("no frontmatter");
  });

  test("degrades to the path-segment name on malformed frontmatter", () => {
    const parsed = parseSkillMarkdown("skill://foo/SKILL.md", "---\nname: [unclosed\n---\nbody");
    expect(parsed.name).toBe("foo");
  });
});

describe("synthesizeBundleSkill", () => {
  test("keys tool-affinity on the server slug, identity on the skill name", () => {
    const skill = synthesizeBundleSkill({
      serverName: "ai-nimblebrain-foo-mcp",
      skillName: "foo",
      description: "Foo workflow.",
      body: "# How to use Foo\n\nBody.",
      uri: "skill://foo/SKILL.md",
    });
    // Decoupling is the fix: affinity keys on the (reverse-DNS slug) server name,
    // identity uses the skill's own name — discovery works when they differ.
    expect(skill.manifest.name).toBe("bundle:ai-nimblebrain-foo-mcp:foo");
    expect(skill.manifest.toolAffinity).toEqual(["ai-nimblebrain-foo-mcp__*"]);
    expect(skill.manifest.loadingStrategy).toBe("dynamic");
    expect(skill.manifest.scope).toBe("bundle");
    expect(skill.manifest.status).toBe("active");
    expect(skill.manifest.description).toBe("Foo workflow.");
    expect(skill.sourcePath).toBe("skill://foo/SKILL.md");
    expect(skill.body).toContain("How to use Foo");
  });

  test("falls back to a generic description when frontmatter omits one", () => {
    const skill = synthesizeBundleSkill({
      serverName: "tasks",
      skillName: "tasks",
      description: "",
      body: "x",
      uri: "skill://tasks/SKILL.md",
    });
    expect(skill.manifest.description).toBe("Workflow guidance from the tasks server");
  });

  test("body passes through unchanged (truncation is the caller's job)", () => {
    const body = "exactly this content";
    const skill = synthesizeBundleSkill({
      serverName: "foo",
      skillName: "foo",
      description: "",
      body,
      uri: "skill://foo/SKILL.md",
    });
    expect(skill.body).toBe(body);
  });
});

describe("selectLayer3Skills with server skills", () => {
  function skill(serverName: string, skillName = serverName) {
    return synthesizeBundleSkill({
      serverName,
      skillName,
      description: "",
      body: `# ${skillName} usage`,
      uri: `skill://${skillName}/SKILL.md`,
    });
  }

  test("loads a server skill when any matching tool is in the active toolset", () => {
    const result = selectLayer3Skills({
      skills: [skill("foo")],
      activeTools: ["foo__do_it", "other__noop"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.skill.manifest.name).toBe("bundle:foo:foo");
    expect(result[0]?.loadedBy).toBe("tool_affinity");
    expect(result[0]?.reason).toContain("foo__*");
  });

  test("does NOT load when no matching tool is in the active toolset", () => {
    const result = selectLayer3Skills({
      skills: [skill("foo")],
      activeTools: ["other__do_it", "another__noop"],
    });
    expect(result).toHaveLength(0);
  });

  test("does NOT load when the toolset is empty", () => {
    const result = selectLayer3Skills({ skills: [skill("foo")], activeTools: [] });
    expect(result).toHaveLength(0);
  });

  test("each server's skill matches only its own tools", () => {
    const result = selectLayer3Skills({
      skills: [skill("synapse-collateral"), skill("synapse-crm")],
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.skill.manifest.name).toBe("bundle:synapse-collateral:synapse-collateral");
  });
});
