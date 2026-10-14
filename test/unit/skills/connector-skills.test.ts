/**
 * Unit tests for the server-skill adapter (SEP-2640 `io.modelcontextprotocol/skills`).
 *
 * The pure functions — `discoveredSkillFromEntry`, `parseSkillMarkdown`,
 * `synthesizeConnectorSkill`, and `hydrateSkill` — are the discovery + synthesis
 * primitives the runtime
 * composes. Combined with `selectLayer3Skills`, we verify end-to-end selection
 * behavior (active toolset → skill loads) without spinning up a Runtime.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { log } from "../../../src/observability/log.ts";
import {
  connectorSkillManifestName,
  connectorToolAffinity,
  discoveredSkillFromEntry,
  hydrateSkill,
  parseConnectorSkillName,
  parseSkillMarkdown,
  reportUnmatchedToolAffinity,
  synthesizeConnectorSkill,
  unmatchedToolAffinity,
} from "../../../src/skills/connector-skills.ts";
import { SkillMatcher } from "../../../src/skills/matcher.ts";
import {
  partitionSkillsByRole,
  selectLayer3Skills,
  toolMatches,
} from "../../../src/skills/select.ts";
import type { SkillBodyLoad } from "../../../src/skills/types.ts";

describe("discoveredSkillFromEntry", () => {
  test("reads name, description, and loading config from the listing, with no body", () => {
    const skill = discoveredSkillFromEntry({
      uri: "skill://acme/capture/SKILL.md",
      frontmatter: {
        name: "capture",
        description: "Capture corrections",
        metadata: { nimblebrain: { "loading-strategy": "always", priority: 20, triggers: ["x"] } },
      },
      resources: "dynamic",
    });
    expect(skill).toMatchObject({
      uri: "skill://acme/capture/SKILL.md",
      name: "capture",
      description: "Capture corrections",
      loadingStrategy: "always",
      priority: 20,
      triggers: ["x"],
    });
    expect("body" in skill).toBe(false);
  });

  test("reads a declared tool-affinity bare, dropping blank and non-string entries", () => {
    const skill = discoveredSkillFromEntry({
      uri: "skill://acme/writing/SKILL.md",
      frontmatter: {
        name: "writing",
        description: "Drafting guidance",
        metadata: { nimblebrain: { "tool-affinity": ["draft_email", " ", 7, "draft_*"] } },
      },
      resources: "dynamic",
    });
    expect(skill.toolAffinity).toEqual(["draft_email", "draft_*"]);
  });

  test("declares no tool-affinity when the listing names none", () => {
    const skill = discoveredSkillFromEntry({
      uri: "skill://acme/usage/SKILL.md",
      frontmatter: { name: "usage", description: "Usage" },
      resources: "dynamic",
    });
    expect(skill.toolAffinity).toBeUndefined();
  });
});

describe("connectorToolAffinity", () => {
  test("prefixes each declared name or glob with the server", () => {
    expect(connectorToolAffinity("acme", ["draft_email", "draft_*"])).toEqual([
      "acme__draft_email",
      "acme__draft_*",
    ]);
  });

  test("falls back to the whole server when nothing usable is declared", () => {
    expect(connectorToolAffinity("acme", undefined)).toEqual(["acme__*"]);
    expect(connectorToolAffinity("acme", [])).toEqual(["acme__*"]);
    expect(connectorToolAffinity("acme", ["", "  "])).toEqual(["acme__*"]);
  });

  test("keeps every declared pattern inside the server's namespace", () => {
    const affinity = connectorToolAffinity("acme", [
      "*",
      "other__send",
      "*__send",
      "ws_00079598e311c160-x",
    ]);
    const matchesAny = (tool: string) => affinity.some((p) => toolMatches(tool, p));
    expect(matchesAny("acme__anything")).toBe(true);
    expect(matchesAny("other__send")).toBe(false);
    expect(matchesAny("my_acme__send")).toBe(false);
    expect(matchesAny("beta__send")).toBe(false);
  });
});

describe("unmatchedToolAffinity", () => {
  const tools = ["acme__draft_email", "acme__send_email"];

  test("returns the patterns no advertised tool matches", () => {
    expect(
      unmatchedToolAffinity(["acme__draft_email", "acme__draft_emial", "acme__reply_*"], tools),
    ).toEqual(["acme__draft_emial", "acme__reply_*"]);
  });

  test("returns nothing when every pattern matches a tool", () => {
    expect(unmatchedToolAffinity(["acme__send_*", "acme__*"], tools)).toEqual([]);
  });
});

describe("reportUnmatchedToolAffinity", () => {
  const warnings = (run: () => void) => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      run();
      return warn.mock.calls.map((c) => c[1]);
    } finally {
      warn.mockRestore();
    }
  };

  test("warns once per skill with an unmatched pattern, naming connector, skill, and patterns", () => {
    const fields = warnings(() =>
      reportUnmatchedToolAffinity({
        wsId: "ws_00079598e311c160",
        serverName: "acme",
        toolNames: ["acme__draft_email"],
        skills: [
          { name: "writing", toolAffinity: ["acme__draft_email"] },
          { name: "outreach", toolAffinity: ["acme__draft_email", "acme__send_*"] },
        ],
      }),
    );
    expect(fields).toEqual([
      {
        event: "skills.tool_affinity.unmatched",
        workspace_id: "ws_00079598e311c160",
        server: "acme",
        skill: "outreach",
        patterns: ["acme__send_*"],
      },
    ]);
  });

  test("says nothing about a connector that advertises no tools yet", () => {
    const fields = warnings(() =>
      reportUnmatchedToolAffinity({
        wsId: "ws_00079598e311c160",
        serverName: "acme",
        toolNames: [],
        skills: [{ name: "outreach", toolAffinity: ["acme__send_*"] }],
      }),
    );
    expect(fields).toEqual([]);
  });
});

describe("hydrateSkill", () => {
  const lazy = (load: () => Promise<SkillBodyLoad>) =>
    synthesizeConnectorSkill({
      serverName: "srv",
      skillName: "s",
      description: "d",
      uri: "skill://s/SKILL.md",
      loadBody: load,
    });

  test("a synthesized skill with a loader carries no body until hydrated", async () => {
    let calls = 0;
    const skill = lazy(async () => {
      calls++;
      return { ok: true, body: "the body" };
    });
    expect(skill.body).toBe("");
    expect(calls).toBe(0);
    const hydrated = await hydrateSkill(skill);
    expect(hydrated?.body).toBe("the body");
    expect(hydrated?.loadBody).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("a failed fetch yields null, and a skill with no loader passes through", async () => {
    expect(await hydrateSkill(lazy(async () => ({ ok: false, reason: "unreachable" })))).toBeNull();
    const eager = synthesizeConnectorSkill({
      serverName: "srv",
      skillName: "s",
      description: "d",
      body: "inline",
      uri: "skill://s/SKILL.md",
    });
    expect(await hydrateSkill(eager)).toBe(eager);
  });
});

describe("parseSkillMarkdown", () => {
  test("extracts name + description from frontmatter and strips it from the body", () => {
    const raw =
      "---\nname: refunds\ndescription: How to process refunds.\n---\n\n# Refunds\n\nBody.";
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

  test("reads back what synthesizeConnectorSkill stamped", () => {
    const skill = synthesizeConnectorSkill({
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
    expect(parseConnectorSkillName("connector:")).toBeNull();
    expect(parseConnectorSkillName("connector::name")).toBeNull();
    expect(parseConnectorSkillName("connector:connector:")).toBeNull();
  });

  test("a skill name containing a colon keeps its whole tail", () => {
    expect(parseConnectorSkillName("connector:acme:billing:refunds")).toEqual({
      connector: "acme",
      name: "billing:refunds",
    });
  });
});

describe("synthesizeConnectorSkill", () => {
  test("keys tool-affinity on the server slug, identity on the skill name", () => {
    const skill = synthesizeConnectorSkill({
      serverName: "ai-nimblebrain-foo-mcp",
      skillName: "foo",
      description: "Foo workflow.",
      body: "# How to use Foo\n\nBody.",
      uri: "skill://foo/SKILL.md",
    });
    // Decoupling is the fix: affinity keys on the (reverse-DNS slug) server name,
    // identity uses the skill's own name — discovery works when they differ.
    expect(skill.manifest.name).toBe("connector:ai-nimblebrain-foo-mcp:foo");
    expect(skill.manifest.toolAffinity).toEqual(["ai-nimblebrain-foo-mcp__*"]);
    expect(skill.manifest.loadingStrategy).toBe("dynamic");
    expect(skill.manifest.scope).toBe("provided");
    expect(skill.manifest.status).toBe("active");
    expect(skill.manifest.description).toBe("Foo workflow.");
    expect(skill.sourcePath).toBe("skill://foo/SKILL.md");
    expect(skill.body).toContain("How to use Foo");
  });

  test("falls back to a generic description when frontmatter omits one", () => {
    const skill = synthesizeConnectorSkill({
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
    const skill = synthesizeConnectorSkill({
      serverName: "foo",
      skillName: "foo",
      description: "",
      body,
      uri: "skill://foo/SKILL.md",
    });
    expect(skill.body).toBe(body);
  });

  test("preserves a declared `always` loading-strategy and priority", () => {
    const skill = synthesizeConnectorSkill({
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
    const skill = synthesizeConnectorSkill({
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
    const skill = synthesizeConnectorSkill({
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
    const skill = synthesizeConnectorSkill({
      serverName: "foo",
      skillName: "foo",
      description: "",
      body: "x",
      uri: "skill://foo/SKILL.md",
    });
    expect(skill.manifest.triggers).toBeUndefined();
  });
});

describe("SkillMatcher over synthesized connector skills", () => {
  const capture = synthesizeConnectorSkill({
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
    expect(hit?.skill.manifest.name).toBe("connector:ai-nimblebrain-foo-mcp:capture");
    expect(hit?.trigger).toBe("that is wrong");
  });

  test("does not fire on a message that names no phrase", () => {
    const matcher = new SkillMatcher();
    matcher.load([capture]);
    expect(matcher.match("draft the onboarding plan")).toBeNull();
  });

  // `SkillMatcher.load()` filters to `dynamic`, so triggers on an `always` connector
  // skill are inert by construction — it already composes every turn. Part of the
  // measured "zero trigger fires" was this filter, not the channel.
  test("an `always` connector skill is never matchable, triggers or not", () => {
    const alwaysOn = synthesizeConnectorSkill({
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

describe("partitionSkillsByRole routes synthesized connector skills by declared strategy", () => {
  test("an `always` connector skill lands in context; a `dynamic` one in capability", () => {
    const always = synthesizeConnectorSkill({
      serverName: "foo",
      skillName: "workflow",
      description: "",
      body: "# always",
      uri: "skill://workflow/SKILL.md",
      loadingStrategy: "always",
    });
    const dynamic = synthesizeConnectorSkill({
      serverName: "bar",
      skillName: "usage",
      description: "",
      body: "# dynamic",
      uri: "skill://usage/SKILL.md",
      // no strategy → defaults to dynamic
    });
    const { context, capability } = partitionSkillsByRole([always, dynamic]);
    expect(context.map((s) => s.manifest.name)).toEqual(["connector:foo:workflow"]);
    expect(capability.map((s) => s.manifest.name)).toEqual(["connector:bar:usage"]);
  });

  test("an `always` connector skill is NOT selected by tool-affinity even when its tools are active", () => {
    const always = synthesizeConnectorSkill({
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
    return synthesizeConnectorSkill({
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
    expect(result[0]?.skill.manifest.name).toBe("connector:foo:foo");
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

  test("a skill declaring tool-affinity loads only for the tools it names", () => {
    const writing = synthesizeConnectorSkill({
      serverName: "acme",
      skillName: "writing",
      description: "",
      body: "# writing",
      uri: "skill://writing/SKILL.md",
      toolAffinity: ["draft_email"],
    });
    expect(writing.manifest.toolAffinity).toEqual(["acme__draft_email"]);
    expect(
      selectLayer3Skills({ skills: [writing], activeTools: ["acme__draft_email"] }),
    ).toHaveLength(1);
    expect(
      selectLayer3Skills({ skills: [writing], activeTools: ["acme__update_settings"] }),
    ).toHaveLength(0);
  });

  test("each server's skill matches only its own tools", () => {
    const result = selectLayer3Skills({
      skills: [skill("synapse-collateral"), skill("synapse-crm")],
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.skill.manifest.name).toBe("connector:synapse-collateral:synapse-collateral");
  });
});
