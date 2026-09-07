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
import { synthesizeConnectorSkill } from "../../../src/skills/connector-skills.ts";
import { buildSkillsLoadedPayload } from "../../../src/runtime/skills-loaded-payload.ts";
import { selectLayer3Skills } from "../../../src/skills/select.ts";

describe("skills.loaded payload — connector skill entry", () => {
  test("synthesized connector skill produces a well-formed payload entry", () => {
    const skill = synthesizeConnectorSkill({
      serverName: "synapse-collateral",
      skillName: "collateral",
      description: "",
      body: "# How to use Collateral\n\nBody.",
      uri: "skill://collateral/SKILL.md",
    });
    const selected = selectLayer3Skills({
      skills: [skill],
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(selected).toHaveLength(1);

    const payload = buildSkillsLoadedPayload(selected);
    expect(payload.skills).toHaveLength(1);

    const entry = payload.skills[0]!;
    // `id` is the sourcePath — the discovered SKILL.md URI tells operators where
    // this came from.
    expect(entry.id).toBe("skill://collateral/SKILL.md");
    // `scope: connector` so web (amber chip) and loading_log filtering work.
    expect(entry.scope).toBe("provided");
    // Layer 3 — selected via tool affinity, not vendored Layer 1.
    expect(entry.layer).toBe(3);
    // Provenance: `tool_affinity` is the observable label
    // (manifest field is `tool_affined`; emitted as `tool_affinity` — Phase 2 contract).
    expect(entry.loadedBy).toBe("tool_affinity");
    expect(entry.reason).toContain("synapse-collateral__*");
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
    const selected = selectLayer3Skills({
      skills: [a, b],
      activeTools: ["a__tool", "b__tool"],
    });
    const payload = buildSkillsLoadedPayload(selected);
    expect(payload.skills).toHaveLength(2);
    const sum = payload.skills.reduce((s, e) => s + e.tokens, 0);
    expect(payload.totalTokens).toBe(sum);
  });
});
