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
  connectorSkillManifestName,
  isSkillEntrypointUri,
  parseConnectorSkillName,
  parseSkillMarkdown,
  synthesizeBundleSkill,
} from "../../../src/skills/bundle-skills.ts";
import { SkillMatcher } from "../../../src/skills/matcher.ts";
import { partitionSkillsByRole, selectLayer3Skills } from "../../../src/skills/select.ts";

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

  test("reads a declared loading-strategy + priority from metadata.nimblebrain", () => {
    const raw =
      "---\nname: workflow\ndescription: Always-on workflow guide.\n" +
      "metadata:\n  nimblebrain:\n    loading-strategy: always\n    priority: 20\n---\n\nBody.";
    const parsed = parseSkillMarkdown("skill://workflow/SKILL.md", raw);
    expect(parsed.loadingStrategy).toBe("always");
    expect(parsed.priority).toBe(20);
  });

  test("leaves strategy/priority undefined when no nimblebrain block is declared", () => {
    const raw = "---\nname: usage\ndescription: Tool usage.\n---\n\nBody.";
    const parsed = parseSkillMarkdown("skill://usage/SKILL.md", raw);
    expect(parsed.loadingStrategy).toBeUndefined();
    expect(parsed.priority).toBeUndefined();
  });

  test("ignores an out-of-range or unrecognized declared value", () => {
    const raw =
      "---\nname: bad\ndescription: Bad values.\n" +
      "metadata:\n  nimblebrain:\n    loading-strategy: sometimes\n    priority: 999\n---\n\nBody.";
    const parsed = parseSkillMarkdown("skill://bad/SKILL.md", raw);
    expect(parsed.loadingStrategy).toBeUndefined();
    expect(parsed.priority).toBeUndefined();
  });

  // The blocker this half of #977 removes: `triggers` is the same
  // `metadata.nimblebrain` field the filesystem loader reads, so identical
  // frontmatter must not behave differently by origin. It parsed fine before and
  // the field was silently dropped on the floor.
  test("reads declared triggers from metadata.nimblebrain", () => {
    const raw =
      "---\nname: capture\ndescription: Capture corrections.\n" +
      "metadata:\n  nimblebrain:\n    loading-strategy: dynamic\n" +
      '    triggers:\n      - "that is wrong"\n      - "actually we"\n---\n\nBody.';
    const parsed = parseSkillMarkdown("skill://capture/SKILL.md", raw);
    expect(parsed.triggers).toEqual(["that is wrong", "actually we"]);
  });

  test("leaves triggers undefined when none are declared", () => {
    const raw = "---\nname: usage\ndescription: Tool usage.\n---\n\nBody.";
    expect(parseSkillMarkdown("skill://usage/SKILL.md", raw).triggers).toBeUndefined();
  });

  // A discovered skill is authored by an arbitrary MCP server, so the read is
  // lenient — but a blank trigger substring-matches EVERY message, which would
  // make one malformed connector skill fire on every turn in the workspace.
  test("drops non-string and blank triggers, and a non-array declaration", () => {
    const mixed =
      "---\nname: messy\ndescription: Messy.\n" +
      "metadata:\n  nimblebrain:\n    triggers:\n" +
      '      - "real phrase"\n      - ""\n      - "   "\n      - 7\n---\n\nBody.';
    expect(parseSkillMarkdown("skill://messy/SKILL.md", mixed).triggers).toEqual(["real phrase"]);

    const notAnArray =
      "---\nname: messy\ndescription: Messy.\n" +
      "metadata:\n  nimblebrain:\n    triggers: just a string\n---\n\nBody.";
    expect(parseSkillMarkdown("skill://messy/SKILL.md", notAnArray).triggers).toBeUndefined();

    const allBlank =
      "---\nname: messy\ndescription: Messy.\n" +
      'metadata:\n  nimblebrain:\n    triggers:\n      - " "\n---\n\nBody.';
    expect(parseSkillMarkdown("skill://messy/SKILL.md", allBlank).triggers).toBeUndefined();
  });
});

describe("connector skill identity round-trip", () => {
  test("parse inverts compose", () => {
    const name = connectorSkillManifestName("ai-nimblebrain-foo-mcp", "billing");
    expect(parseConnectorSkillName(name)).toEqual({
      connector: "ai-nimblebrain-foo-mcp",
      name: "billing",
    });
  });

  test("reads back what synthesizeBundleSkill stamped", () => {
    const skill = synthesizeBundleSkill({
      serverName: "com-canva-mcp",
      skillName: "design",
      description: "",
      body: "x",
      uri: "skill://canva/design/SKILL.md",
    });
    expect(parseConnectorSkillName(skill.manifest.name)).toEqual({
      connector: "com-canva-mcp",
      name: "design",
    });
  });

  // On-disk skill names can't contain a colon (SKILL_NAME_PATTERN), so no
  // filesystem skill can be mistaken for a connector's.
  test("returns null for a name this module did not build", () => {
    expect(parseConnectorSkillName("release-notes")).toBeNull();
    expect(parseConnectorSkillName("identity-override")).toBeNull();
    expect(parseConnectorSkillName("bundle:")).toBeNull();
    expect(parseConnectorSkillName("bundle::name")).toBeNull();
    expect(parseConnectorSkillName("bundle:connector:")).toBeNull();
  });

  test("a skill name containing a colon keeps its whole tail", () => {
    expect(parseConnectorSkillName("bundle:acme:billing:refunds")).toEqual({
      connector: "acme",
      name: "billing:refunds",
    });
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

  test("preserves a declared `always` loading-strategy and priority", () => {
    const skill = synthesizeBundleSkill({
      serverName: "foo",
      skillName: "workflow",
      description: "Always-on guide.",
      body: "# Always",
      uri: "skill://workflow/SKILL.md",
      loadingStrategy: "always",
      priority: 20,
    });
    expect(skill.manifest.loadingStrategy).toBe("always");
    expect(skill.manifest.priority).toBe(20);
  });

  test("defaults to `dynamic` at priority 60 when no strategy is declared", () => {
    const skill = synthesizeBundleSkill({
      serverName: "foo",
      skillName: "foo",
      description: "",
      body: "x",
      uri: "skill://foo/SKILL.md",
    });
    expect(skill.manifest.loadingStrategy).toBe("dynamic");
    expect(skill.manifest.priority).toBe(60);
  });

  test("stamps declared triggers alongside tool-affinity, so both channels reach it", () => {
    const skill = synthesizeBundleSkill({
      serverName: "ai-nimblebrain-foo-mcp",
      skillName: "capture",
      description: "Capture corrections.",
      body: "# Capture",
      uri: "skill://capture/SKILL.md",
      triggers: ["that is wrong"],
    });
    expect(skill.manifest.triggers).toEqual(["that is wrong"]);
    // Affinity is still stamped — triggers are additive, not a replacement.
    expect(skill.manifest.toolAffinity).toEqual(["ai-nimblebrain-foo-mcp__*"]);
  });

  test("omits triggers entirely when none are declared", () => {
    const skill = synthesizeBundleSkill({
      serverName: "foo",
      skillName: "foo",
      description: "",
      body: "x",
      uri: "skill://foo/SKILL.md",
    });
    expect(skill.manifest.triggers).toBeUndefined();
  });
});

describe("SkillMatcher over synthesized bundle skills", () => {
  const capture = synthesizeBundleSkill({
    serverName: "ai-nimblebrain-foo-mcp",
    skillName: "capture",
    description: "Capture corrections.",
    body: "# Capture",
    uri: "skill://capture/SKILL.md",
    triggers: ["that is wrong"],
  });

  test("fires on a declared phrase, case-insensitively", () => {
    const matcher = new SkillMatcher();
    matcher.load([capture]);
    const hit = matcher.match("Actually That Is Wrong — we do not target dentists");
    expect(hit?.skill.manifest.name).toBe("bundle:ai-nimblebrain-foo-mcp:capture");
    expect(hit?.trigger).toBe("that is wrong");
  });

  test("does not fire on a message that names no phrase", () => {
    const matcher = new SkillMatcher();
    matcher.load([capture]);
    expect(matcher.match("draft the onboarding plan")).toBeNull();
  });

  // `SkillMatcher.load()` filters to `dynamic`, so triggers on an `always` bundle
  // skill are inert by construction — it already composes every turn. Part of the
  // measured "zero trigger fires" was this filter, not the channel.
  test("an `always` bundle skill is never matchable, triggers or not", () => {
    const alwaysOn = synthesizeBundleSkill({
      serverName: "foo",
      skillName: "guide",
      description: "",
      body: "x",
      uri: "skill://guide/SKILL.md",
      loadingStrategy: "always",
      triggers: ["that is wrong"],
    });
    const matcher = new SkillMatcher();
    matcher.load([alwaysOn]);
    expect(matcher.match("that is wrong")).toBeNull();
  });
});

describe("partitionSkillsByRole routes synthesized bundle skills by declared strategy", () => {
  test("an `always` bundle skill lands in context; a `dynamic` one in capability", () => {
    const always = synthesizeBundleSkill({
      serverName: "foo",
      skillName: "workflow",
      description: "",
      body: "# always",
      uri: "skill://workflow/SKILL.md",
      loadingStrategy: "always",
    });
    const dynamic = synthesizeBundleSkill({
      serverName: "bar",
      skillName: "usage",
      description: "",
      body: "# dynamic",
      uri: "skill://usage/SKILL.md",
      // no strategy → defaults to dynamic
    });
    const { context, capability } = partitionSkillsByRole([always, dynamic]);
    expect(context.map((s) => s.manifest.name)).toEqual(["bundle:foo:workflow"]);
    expect(capability.map((s) => s.manifest.name)).toEqual(["bundle:bar:usage"]);
  });

  test("an `always` bundle skill is NOT selected by tool-affinity even when its tools are active", () => {
    const always = synthesizeBundleSkill({
      serverName: "foo",
      skillName: "workflow",
      description: "",
      body: "# always",
      uri: "skill://workflow/SKILL.md",
      loadingStrategy: "always",
    });
    // It rides the context channel unconditionally, so Layer 3 must skip it.
    const result = selectLayer3Skills({ skills: [always], activeTools: ["foo__do_it"] });
    expect(result).toHaveLength(0);
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
