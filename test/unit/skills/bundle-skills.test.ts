/**
 * Unit tests for the bundle-skill adapter.
 *
 * `synthesizeBundleSkill` is a pure function: given a server name + body,
 * produce a `Skill` with the right manifest shape for Layer 3 selection.
 * Combined with `selectLayer3Skills`, we verify the end-to-end selection
 * behavior (active toolset → skill loads) without spinning up a Runtime.
 */

import { describe, expect, test } from "bun:test";
import { synthesizeBundleSkill } from "../../../src/skills/bundle-skills.ts";
import { selectLayer3Skills } from "../../../src/skills/select.ts";

describe("synthesizeBundleSkill", () => {
  test("produces a tool_affined skill with <name>__* glob", () => {
    const skill = synthesizeBundleSkill({
      serverName: "synapse-collateral",
      body: "# How to use Collateral\n\nBody.",
    });
    expect(skill.manifest.name).toBe("bundle:synapse-collateral");
    expect(skill.manifest.loadingStrategy).toBe("tool_affined");
    expect(skill.manifest.appliesToTools).toEqual(["synapse-collateral__*"]);
    expect(skill.manifest.scope).toBe("bundle");
    expect(skill.manifest.status).toBe("active");
    expect(skill.manifest.type).toBe("skill");
    expect(skill.sourcePath).toBe("skill://synapse-collateral/usage");
    expect(skill.body).toContain("How to use Collateral");
  });

  test("description references the bundle name for telemetry clarity", () => {
    const skill = synthesizeBundleSkill({
      serverName: "tasks",
      body: "x",
    });
    expect(skill.manifest.description).toBe("Workflow guidance from the tasks bundle");
  });

  test("body passes through unchanged (truncation is the caller's job)", () => {
    const body = "exactly this content";
    const skill = synthesizeBundleSkill({ serverName: "foo", body });
    expect(skill.body).toBe(body);
  });
});

describe("selectLayer3Skills with bundle skills", () => {
  test("loads a bundle skill when any matching tool is in the active toolset", () => {
    const skill = synthesizeBundleSkill({
      serverName: "foo",
      body: "# foo usage",
    });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["foo__do_it", "other__noop"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.skill.manifest.name).toBe("bundle:foo");
    expect(result[0]?.loadedBy).toBe("tool_affinity");
    expect(result[0]?.reason).toContain("foo__*");
  });

  test("does NOT load a bundle skill when no matching tool is in the active toolset", () => {
    const skill = synthesizeBundleSkill({
      serverName: "foo",
      body: "# foo usage",
    });
    const result = selectLayer3Skills({
      skills: [skill],
      activeTools: ["other__do_it", "another__noop"],
    });
    expect(result).toHaveLength(0);
  });

  test("does NOT load a bundle skill when the toolset is empty", () => {
    const skill = synthesizeBundleSkill({
      serverName: "foo",
      body: "# foo usage",
    });
    const result = selectLayer3Skills({ skills: [skill], activeTools: [] });
    expect(result).toHaveLength(0);
  });

  test("each bundle's skill matches only its own tools", () => {
    const collateral = synthesizeBundleSkill({
      serverName: "synapse-collateral",
      body: "collateral",
    });
    const crm = synthesizeBundleSkill({
      serverName: "synapse-crm",
      body: "crm",
    });
    // Only collateral tools active.
    const result = selectLayer3Skills({
      skills: [collateral, crm],
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.skill.manifest.name).toBe("bundle:synapse-collateral");
  });
});
