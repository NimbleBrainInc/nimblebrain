/**
 * Layer 3 selection + role partition.
 *
 * `selectLayer3Skills` is a pure function: `dynamic` skills + active tools →
 * the tool-affinity-matched subset. `always` skills are NOT selected here —
 * they compose into the context channel (see `partitionSkillsByRole`).
 */

import { describe, expect, test } from "bun:test";
import {
  partitionSkillsByRole,
  selectLayer3Skills,
  toolMatches,
} from "../../../src/skills/select.ts";
import type { Skill, SkillLoadingStrategy, SkillStatus } from "../../../src/skills/types.ts";

interface SkillFixtureOptions {
  name: string;
  priority?: number;
  loadingStrategy?: SkillLoadingStrategy;
  toolAffinity?: string[];
  triggers?: string[];
  status?: SkillStatus;
  sourcePath?: string;
}

function makeSkill(opts: SkillFixtureOptions): Skill {
  return {
    manifest: {
      name: opts.name,
      description: `${opts.name} description`,
      loadingStrategy: opts.loadingStrategy ?? "dynamic",
      priority: opts.priority ?? 50,
      status: opts.status ?? "active",
      ...(opts.toolAffinity ? { toolAffinity: opts.toolAffinity } : {}),
      ...(opts.triggers ? { triggers: opts.triggers } : {}),
    },
    body: `# ${opts.name}\n`,
    sourcePath: opts.sourcePath ?? `/virtual/${opts.name}.md`,
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
    expect(toolMatches("synapse-collateral__patch_source", "synapse-collateral__patch_source")).toBe(
      true,
    );
    expect(toolMatches("synapse-collateral__patch_sources", "synapse-collateral__patch_source")).toBe(
      false,
    );
    expect(toolMatches("synapse-collateral__set_source", "synapse-collateral__patch_source")).toBe(
      false,
    );
  });

  test("empty pattern returns false", () => {
    expect(toolMatches("anything", "")).toBe(false);
    expect(toolMatches("", "")).toBe(false);
  });
});

describe("selectLayer3Skills — dynamic + tool-affinity", () => {
  test("matching tool → included, reason names matched pattern", () => {
    const skill = makeSkill({
      name: "collateral-helper",
      loadingStrategy: "dynamic",
      toolAffinity: ["synapse-collateral__*"],
    });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["synapse-collateral__patch_source", "unrelated__noop"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.loadedBy).toBe("tool_affinity");
    expect(result[0]?.reason).toBe("tool-affinity matched synapse-collateral__*");
  });

  test("multiple matched patterns are joined in reason", () => {
    const skill = makeSkill({
      name: "multi-match",
      loadingStrategy: "dynamic",
      toolAffinity: ["synapse-collateral__*", "*__patch_source", "unrelated__*"],
    });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe("tool-affinity matched synapse-collateral__*, *__patch_source");
  });

  test("no matching tool → not included", () => {
    const skill = makeSkill({
      name: "collateral-helper",
      loadingStrategy: "dynamic",
      toolAffinity: ["synapse-collateral__*"],
    });
    const result = selectLayer3Skills({ skills: [skill], activeTools: ["synapse-crm__contact"] });
    expect(result).toHaveLength(0);
  });

  test("dynamic with no tool-affinity → catalog-only, not selected", () => {
    const skill = makeSkill({ name: "catalog-only", loadingStrategy: "dynamic" });
    const result = selectLayer3Skills({ skills: [skill], activeTools: ["foo__bar"] });
    expect(result).toHaveLength(0);
  });

  test("`always` skills are NOT selected here (they compose into the context channel)", () => {
    const skill = makeSkill({ name: "voice", loadingStrategy: "always" });
    const result = selectLayer3Skills({ skills: [skill], activeTools: ["foo__bar"] });
    expect(result).toHaveLength(0);
  });

  test("disabled dynamic skill → not included", () => {
    const skill = makeSkill({
      name: "off",
      loadingStrategy: "dynamic",
      toolAffinity: ["foo__*"],
      status: "disabled",
    });
    const result = selectLayer3Skills({ skills: [skill], activeTools: ["foo__bar"] });
    expect(result).toHaveLength(0);
  });

  test("`*` matches any active tool when non-empty; not when empty", () => {
    const skill = makeSkill({ name: "wild", loadingStrategy: "dynamic", toolAffinity: ["*"] });
    expect(
      selectLayer3Skills({ skills: [skill], activeTools: ["synapse-crm__contact"] }),
    ).toHaveLength(1);
    expect(selectLayer3Skills({ skills: [skill], activeTools: [] })).toHaveLength(0);
  });

  test("included skills are sorted by priority ascending", () => {
    const skills = [50, 15, 99, 20].map((p) =>
      makeSkill({ name: `p${p}`, loadingStrategy: "dynamic", toolAffinity: ["*"], priority: p }),
    );
    const result = selectLayer3Skills({ skills, activeTools: ["x__y"] });
    expect(result.map((s) => s.skill.manifest.name)).toEqual(["p15", "p20", "p50", "p99"]);
  });

  test("mixed pool: only dynamic + matching affinity is selected", () => {
    const skills: Skill[] = [
      makeSkill({ name: "always-active", loadingStrategy: "always", priority: 30 }),
      makeSkill({
        name: "tool-match",
        loadingStrategy: "dynamic",
        toolAffinity: ["synapse-collateral__*"],
        priority: 40,
      }),
      makeSkill({
        name: "tool-nomatch",
        loadingStrategy: "dynamic",
        toolAffinity: ["synapse-crm__*"],
        priority: 25,
      }),
      makeSkill({ name: "catalog-only", loadingStrategy: "dynamic", priority: 15 }),
    ];
    const result = selectLayer3Skills({
      skills,
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(result.map((s) => s.skill.manifest.name)).toEqual(["tool-match"]);
  });
});

describe("partitionSkillsByRole", () => {
  test("routes by loading-strategy: always → context, dynamic → capability", () => {
    const pool: Skill[] = [
      makeSkill({ name: "soul", loadingStrategy: "always", priority: 0 }),
      makeSkill({ name: "tool-helper", loadingStrategy: "dynamic", toolAffinity: ["x__*"] }),
      makeSkill({ name: "voice", loadingStrategy: "always", priority: 30 }),
    ];
    const { context, capability } = partitionSkillsByRole(pool);
    expect(context.map((s) => s.manifest.name)).toEqual(["soul", "voice"]);
    expect(capability.map((s) => s.manifest.name)).toEqual(["tool-helper"]);
  });

  test("the two sets are disjoint — no skill appears in both", () => {
    const pool: Skill[] = [
      makeSkill({ name: "ctx", loadingStrategy: "always" }),
      makeSkill({ name: "cap", loadingStrategy: "dynamic" }),
    ];
    const { context, capability } = partitionSkillsByRole(pool);
    const ctxNames = new Set(context.map((s) => s.manifest.name));
    expect(capability.some((s) => ctxNames.has(s.manifest.name))).toBe(false);
  });

  test("context channel is sorted by priority ascending", () => {
    const pool: Skill[] = [50, 0, 20].map((p) =>
      makeSkill({ name: `p${p}`, loadingStrategy: "always", priority: p }),
    );
    expect(partitionSkillsByRole(pool).context.map((s) => s.manifest.name)).toEqual([
      "p0",
      "p20",
      "p50",
    ]);
  });

  test("disabled always skills are dropped from the context channel", () => {
    const pool: Skill[] = [
      makeSkill({ name: "active-ctx", loadingStrategy: "always", status: "active" }),
      makeSkill({ name: "off-ctx", loadingStrategy: "always", status: "disabled" }),
    ];
    expect(partitionSkillsByRole(pool).context.map((s) => s.manifest.name)).toEqual(["active-ctx"]);
  });

  test("a workspace/user-tier always skill (non-boot sourcePath) still routes to context", () => {
    const pool: Skill[] = [
      makeSkill({
        name: "ws-rule",
        loadingStrategy: "always",
        sourcePath: "/work/workspaces/ws_x/skills/ws-rule.md",
      }),
    ];
    const { context, capability } = partitionSkillsByRole(pool);
    expect(context.map((s) => s.manifest.name)).toEqual(["ws-rule"]);
    expect(capability).toHaveLength(0);
  });
});
