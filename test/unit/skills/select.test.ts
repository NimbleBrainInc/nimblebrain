/**
 * Phase 2 — Layer 3 selection tests.
 *
 * `selectLayer3Skills` is a pure function: skill list + active tools →
 * selected skills with reason metadata. These tests construct real `Skill`
 * fixtures (no mocking) and assert observable selection + ordering behavior.
 */

import { describe, expect, test } from "bun:test";
import { selectLayer3Skills, toolMatches } from "../../../src/skills/select.ts";
import type {
  Skill,
  SkillLoadingStrategy,
  SkillStatus,
} from "../../../src/skills/types.ts";

interface SkillFixtureOptions {
  name: string;
  priority?: number;
  loadingStrategy?: SkillLoadingStrategy;
  appliesToTools?: string[];
  status?: SkillStatus;
}

function makeSkill(opts: SkillFixtureOptions): Skill {
  return {
    manifest: {
      name: opts.name,
      description: `${opts.name} description`,
      version: "1.0.0",
      type: "context",
      priority: opts.priority ?? 50,
      loadingStrategy: opts.loadingStrategy,
      appliesToTools: opts.appliesToTools,
      status: opts.status,
    },
    body: `# ${opts.name}\n`,
    sourcePath: `/virtual/${opts.name}.md`,
  };
}

describe("toolMatches", () => {
  test("`*` matches anything", () => {
    expect(toolMatches("synapse-collateral__patch_source", "*")).toBe(true);
    expect(toolMatches("anything", "*")).toBe(true);
    expect(toolMatches("", "*")).toBe(true);
  });

  test("`<bundle>__*` matches any tool from that bundle", () => {
    expect(toolMatches("synapse-collateral__patch_source", "synapse-collateral__*")).toBe(true);
    expect(toolMatches("synapse-collateral__set_source", "synapse-collateral__*")).toBe(true);
    expect(toolMatches("synapse-crm__contact", "synapse-collateral__*")).toBe(false);
  });

  test("`*__<tool>` matches a specific tool name across bundles", () => {
    expect(toolMatches("synapse-collateral__patch_source", "*__patch_source")).toBe(true);
    expect(toolMatches("synapse-crm__patch_source", "*__patch_source")).toBe(true);
    expect(toolMatches("synapse-collateral__set_source", "*__patch_source")).toBe(false);
  });

  test("exact pattern matches only its exact name", () => {
    expect(toolMatches("synapse-collateral__patch_source", "synapse-collateral__patch_source")).toBe(true);
    expect(toolMatches("synapse-collateral__patch_sources", "synapse-collateral__patch_source")).toBe(false);
    expect(toolMatches("synapse-collateral__set_source", "synapse-collateral__patch_source")).toBe(false);
  });

  test("empty pattern returns false", () => {
    expect(toolMatches("anything", "")).toBe(false);
    expect(toolMatches("", "")).toBe(false);
  });
});

describe("selectLayer3Skills — `always` strategy", () => {
  test("active + always → included with `loadedBy: \"always\"`", () => {
    const skill = makeSkill({
      name: "voice-rules",
      loadingStrategy: "always",
      status: "active",
    });
    const result = selectLayer3Skills({ skills: [skill], activeTools: [] });
    expect(result).toHaveLength(1);
    expect(result[0]?.loadedBy).toBe("always");
    expect(result[0]?.reason).toBe("loading_strategy: always");
    expect(result[0]?.skill).toBe(skill);
  });

  test("draft status → not included", () => {
    const skill = makeSkill({
      name: "voice-rules",
      loadingStrategy: "always",
      status: "draft",
    });
    const result = selectLayer3Skills({ skills: [skill], activeTools: [] });
    expect(result).toHaveLength(0);
  });

  test("disabled and archived statuses → not included", () => {
    const disabled = makeSkill({
      name: "disabled-skill",
      loadingStrategy: "always",
      status: "disabled",
    });
    const archived = makeSkill({
      name: "archived-skill",
      loadingStrategy: "always",
      status: "archived",
    });
    const result = selectLayer3Skills({
      skills: [disabled, archived],
      activeTools: [],
    });
    expect(result).toHaveLength(0);
  });

  test("undefined status is treated as active", () => {
    const skill = makeSkill({
      name: "no-status",
      loadingStrategy: "always",
    });
    const result = selectLayer3Skills({ skills: [skill], activeTools: [] });
    expect(result).toHaveLength(1);
  });
});

describe("selectLayer3Skills — `tool_affined` strategy", () => {
  test("matching tool → included, reason names matched pattern", () => {
    const skill = makeSkill({
      name: "collateral-helper",
      loadingStrategy: "tool_affined",
      appliesToTools: ["synapse-collateral__*"],
      status: "active",
    });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["synapse-collateral__patch_source", "unrelated__noop"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.loadedBy).toBe("tool_affinity");
    expect(result[0]?.reason).toBe("applies_to_tools matched synapse-collateral__*");
  });

  test("multiple matched patterns are joined in reason", () => {
    const skill = makeSkill({
      name: "multi-match",
      loadingStrategy: "tool_affined",
      appliesToTools: ["synapse-collateral__*", "*__patch_source", "unrelated__*"],
      status: "active",
    });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe(
      "applies_to_tools matched synapse-collateral__*, *__patch_source",
    );
  });

  test("no matching tool → not included", () => {
    const skill = makeSkill({
      name: "collateral-helper",
      loadingStrategy: "tool_affined",
      appliesToTools: ["synapse-collateral__*"],
      status: "active",
    });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["synapse-crm__contact"],
    });
    expect(result).toHaveLength(0);
  });

  test("empty appliesToTools → not included, no error", () => {
    const empty = makeSkill({
      name: "empty",
      loadingStrategy: "tool_affined",
      appliesToTools: [],
      status: "active",
    });
    const missing = makeSkill({
      name: "missing",
      loadingStrategy: "tool_affined",
      status: "active",
    });
    const result = selectLayer3Skills({
      skills: [empty, missing],
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(result).toHaveLength(0);
  });

  test("`*` pattern matches any active tool when activeTools is non-empty", () => {
    const skill = makeSkill({
      name: "wildcard",
      loadingStrategy: "tool_affined",
      appliesToTools: ["*"],
      status: "active",
    });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["synapse-crm__contact"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.loadedBy).toBe("tool_affinity");
  });

  test("`*` pattern with empty activeTools does NOT match", () => {
    const skill = makeSkill({
      name: "wildcard",
      loadingStrategy: "tool_affined",
      appliesToTools: ["*"],
      status: "active",
    });
    const result = selectLayer3Skills({ skills: [skill], activeTools: [] });
    expect(result).toHaveLength(0);
  });
});

describe("selectLayer3Skills — strategy resolution", () => {
  test("skill without loadingStrategy is skipped (legacy path)", () => {
    const skill = makeSkill({ name: "legacy" });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["foo__bar"],
    });
    expect(result).toHaveLength(0);
  });

  test("retrieval strategy is silently skipped (Phase 6)", () => {
    const skill = makeSkill({
      name: "future-retrieval",
      loadingStrategy: "retrieval",
      status: "active",
    });
    expect(() =>
      selectLayer3Skills({ skills: [skill], activeTools: [] }),
    ).not.toThrow();
    const result = selectLayer3Skills({ skills: [skill], activeTools: [] });
    expect(result).toHaveLength(0);
  });

  test("explicit strategy is silently skipped (Phase 7)", () => {
    const skill = makeSkill({
      name: "future-explicit",
      loadingStrategy: "explicit",
      status: "active",
    });
    expect(() =>
      selectLayer3Skills({ skills: [skill], activeTools: [] }),
    ).not.toThrow();
    const result = selectLayer3Skills({ skills: [skill], activeTools: [] });
    expect(result).toHaveLength(0);
  });
});

describe("selectLayer3Skills — mixed input + ordering", () => {
  test("mixed list of 5 skills produces expected included set", () => {
    const skills: Skill[] = [
      // included (always, active)
      makeSkill({
        name: "always-active",
        loadingStrategy: "always",
        status: "active",
        priority: 30,
      }),
      // excluded (always, draft)
      makeSkill({
        name: "always-draft",
        loadingStrategy: "always",
        status: "draft",
        priority: 20,
      }),
      // included (tool_affined, matches)
      makeSkill({
        name: "tool-match",
        loadingStrategy: "tool_affined",
        appliesToTools: ["synapse-collateral__*"],
        status: "active",
        priority: 40,
      }),
      // excluded (tool_affined, no match)
      makeSkill({
        name: "tool-nomatch",
        loadingStrategy: "tool_affined",
        appliesToTools: ["synapse-crm__*"],
        status: "active",
        priority: 25,
      }),
      // excluded (no strategy)
      makeSkill({
        name: "no-strategy",
        priority: 15,
      }),
    ];
    const result = selectLayer3Skills({
      skills,
      activeTools: ["synapse-collateral__patch_source"],
    });
    const names = result.map((s) => s.skill.manifest.name);
    expect(names).toEqual(["always-active", "tool-match"]);
  });

  test("included skills are returned sorted by priority ascending", () => {
    const skills: Skill[] = [
      makeSkill({ name: "p50", loadingStrategy: "always", status: "active", priority: 50 }),
      makeSkill({ name: "p15", loadingStrategy: "always", status: "active", priority: 15 }),
      makeSkill({ name: "p99", loadingStrategy: "always", status: "active", priority: 99 }),
      makeSkill({ name: "p20", loadingStrategy: "always", status: "active", priority: 20 }),
    ];
    const result = selectLayer3Skills({ skills, activeTools: [] });
    expect(result.map((s) => s.skill.manifest.name)).toEqual([
      "p15",
      "p20",
      "p50",
      "p99",
    ]);
  });
});
