/**
 * The tool-affinity glob matcher and the role partition.
 */

import { describe, expect, test } from "bun:test";
import { partitionSkillsByRole, toolMatches } from "../../../src/skills/select.ts";
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

  test("`<connector>__*` matches any tool from that connector", () => {
    expect(toolMatches("synapse-collateral__patch_source", "synapse-collateral__*")).toBe(true);
    expect(toolMatches("synapse-collateral__set_source", "synapse-collateral__*")).toBe(true);
    expect(toolMatches("synapse-crm__contact", "synapse-collateral__*")).toBe(false);
  });

  test("`*__<tool>` matches a specific tool name across connectors", () => {
    expect(toolMatches("synapse-collateral__patch_source", "*__patch_source")).toBe(true);
    expect(toolMatches("synapse-crm__patch_source", "*__patch_source")).toBe(true);
    expect(toolMatches("synapse-collateral__set_source", "*__patch_source")).toBe(false);
  });

  test("exact pattern matches only its exact name", () => {
    expect(
      toolMatches("synapse-collateral__patch_source", "synapse-collateral__patch_source"),
    ).toBe(true);
    expect(
      toolMatches("synapse-collateral__patch_sources", "synapse-collateral__patch_source"),
    ).toBe(false);
    expect(toolMatches("synapse-collateral__set_source", "synapse-collateral__patch_source")).toBe(
      false,
    );
  });

  test("empty pattern returns false", () => {
    expect(toolMatches("anything", "")).toBe(false);
    expect(toolMatches("", "")).toBe(false);
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
        sourcePath: "/work/workspaces/ws_008bd230f095f38a/skills/ws-rule.md",
      }),
    ];
    const { context, capability } = partitionSkillsByRole(pool);
    expect(context.map((s) => s.manifest.name)).toEqual(["ws-rule"]);
    expect(capability).toHaveLength(0);
  });
});
