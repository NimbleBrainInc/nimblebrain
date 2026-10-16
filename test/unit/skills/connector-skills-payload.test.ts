/**
 * Observability test: a synthesized connector skill must show up in the
 * `skills.loaded` event payload with the right id, scope, and loadedBy
 * values so downstream consumers (SkillsPopover, skills__loading_log,
 * skills__loading_log) can render and filter it.
 *
 * This is a thin guardrail — drift between the synthesizer's manifest
 * shape and the payload builder's field selection would break web display
 * (no scope chip), tool output (loading_log missing the entry), and event
 * log replay.
 */

import { describe, expect, test } from "bun:test";
import { buildSkillsLoadedPayload } from "../../../src/runtime/skills-loaded-payload.ts";
import { synthesizeConnectorSkill } from "../../../src/skills/connector-skills.ts";

describe("skills.loaded payload — connector skill entry", () => {
  test("synthesized connector skill produces a well-formed payload entry", () => {
    const skill = synthesizeConnectorSkill({
      serverName: "synapse-collateral",
      skillName: "collateral",
      description: "",
      body: "# How to use Collateral\n\nBody.",
      uri: "skill://collateral/SKILL.md",
    });
    const payload = buildSkillsLoadedPayload([
      { skill, loadedBy: "trigger", reason: 'trigger matched "collateral"' },
    ]);
    expect(payload.skills).toHaveLength(1);

    const entry = payload.skills[0]!;
    // `id` is the sourcePath — the discovered SKILL.md URI tells operators where
    // this came from.
    expect(entry.id).toBe("skill://collateral/SKILL.md");
    // `scope: connector` so web (amber chip) and loading_log filtering work.
    expect(entry.scope).toBe("provided");
    // The mechanism layer follows loadedBy (trigger = 4).
    expect(entry.layer).toBe(4);
    expect(entry.loadedBy).toBe("trigger");
    expect(entry.reason).toContain("collateral");
    // Tokens approximated for total-budget telemetry.
    expect(entry.tokens).toBeGreaterThan(0);
    // Content hash present so mutation detection works.
    expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // No filesystem version for in-memory connector skills — empty string is OK.
    expect(entry.version).toBe("");
  });

  test("multiple connector skills sum tokens into payload total", () => {
    const a = synthesizeConnectorSkill({
      serverName: "a",
      skillName: "a",
      description: "",
      body: "alpha body",
      uri: "skill://a/SKILL.md",
    });
    const b = synthesizeConnectorSkill({
      serverName: "b",
      skillName: "b",
      description: "",
      body: "beta body",
      uri: "skill://b/SKILL.md",
    });
    const payload = buildSkillsLoadedPayload(
      [a, b].map((skill) => ({ skill, loadedBy: "trigger" as const, reason: "r" })),
    );
    expect(payload.skills).toHaveLength(2);
    const sum = payload.skills.reduce((s, e) => s + e.tokens, 0);
    expect(payload.totalTokens).toBe(sum);
  });
});
