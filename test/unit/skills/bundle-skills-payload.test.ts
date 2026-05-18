/**
 * Observability test: a synthesized bundle skill must show up in the
 * `skills.loaded` event payload with the right id, scope, and loadedBy
 * values so downstream consumers (SkillsPopover, skills__active_for,
 * skills__loading_log) can render and filter it.
 *
 * This is a thin guardrail — drift between the synthesizer's manifest
 * shape and the payload builder's field selection would break web display
 * (no scope chip), tool output (active_for missing the entry), and event
 * log replay.
 */

import { describe, expect, test } from "bun:test";
import { synthesizeBundleSkill } from "../../../src/skills/bundle-skills.ts";
import { buildSkillsLoadedPayload } from "../../../src/runtime/skills-loaded-payload.ts";
import { selectLayer3Skills } from "../../../src/skills/select.ts";

describe("skills.loaded payload — bundle skill entry", () => {
  test("synthesized bundle skill produces a well-formed payload entry", () => {
    const skill = synthesizeBundleSkill({
      serverName: "synapse-collateral",
      body: "# How to use Collateral\n\nBody.",
    });
    const selected = selectLayer3Skills({
      skills: [skill],
      activeTools: ["synapse-collateral__patch_source"],
    });
    expect(selected).toHaveLength(1);

    const payload = buildSkillsLoadedPayload(selected);
    expect(payload.skills).toHaveLength(1);

    const entry = payload.skills[0]!;
    // `id` is the sourcePath — the URI tells operators where this came from.
    expect(entry.id).toBe("skill://synapse-collateral/usage");
    // `scope: bundle` so web (amber chip) and active_for filtering work.
    expect(entry.scope).toBe("bundle");
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
    // No filesystem version for in-memory bundle skills — empty string is OK.
    expect(entry.version).toBe("");
  });

  test("multiple bundle skills sum tokens into payload total", () => {
    const a = synthesizeBundleSkill({ serverName: "a", body: "alpha body" });
    const b = synthesizeBundleSkill({ serverName: "b", body: "beta body" });
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
