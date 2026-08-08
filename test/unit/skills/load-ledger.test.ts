/**
 * The skill-load ledger projection.
 *
 * The property under test is coverage: before this projection existed, the
 * only readable channel was `skills.loaded`, so the two channels that actually
 * deliver most guidance — surface-once overlays and catalog activation — were
 * invisible to every read tool. These tests pin that all three project, that
 * they carry a distinguishable `loaded_by`, and that a run-shaped event fans
 * out to skill-shaped rows.
 */

import { describe, expect, test } from "bun:test";
import type { ConversationEvent } from "../../../src/conversation/types.ts";
import { projectSkillLoads } from "../../../src/skills/load-ledger.ts";

const CONV = "conv_test";

function skillsLoaded(
  ts: string,
  runId: string,
  skills: Array<Record<string, unknown>>,
): ConversationEvent {
  return {
    ts,
    type: "skills.loaded",
    runId,
    skills,
    totalTokens: skills.reduce((n, s) => n + ((s.tokens as number) ?? 0), 0),
  } as unknown as ConversationEvent;
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "/skills/voice.md",
    name: "voice",
    layer: 0,
    scope: "workspace",
    version: "1.0.0",
    tokens: 120,
    contentHash: "abc",
    loadedBy: "always",
    reason: "always-on",
    ...over,
  };
}

function connectorInjected(ts: string, over: Record<string, unknown> = {}): ConversationEvent {
  return {
    ts,
    type: "connector.skill.injected",
    toolName: "gmail__send",
    skillName: "gmail-usage",
    skillBody: "x".repeat(400),
    scope: "connector",
    ...over,
  } as unknown as ConversationEvent;
}

function activated(ts: string, over: Record<string, unknown> = {}): ConversationEvent {
  return {
    ts,
    type: "skill.activated",
    runId: "run-9",
    toolCallId: "tc-1",
    skillName: "invoice-runbook",
    scope: "workspace",
    tokens: 300,
    ...over,
  } as unknown as ConversationEvent;
}

describe("projectSkillLoads — channel coverage", () => {
  test("projects all three channels, each with its own loaded_by", () => {
    const rows = projectSkillLoads(CONV, [
      skillsLoaded("2026-08-01T00:00:00Z", "run-1", [entry()]),
      connectorInjected("2026-08-01T00:01:00Z"),
      activated("2026-08-01T00:02:00Z"),
    ]);

    expect(rows.map((r) => r.loaded_by)).toEqual(["always", "tool_use", "activation"]);
    expect(rows.map((r) => r.skill)).toEqual(["voice", "gmail-usage", "invoice-runbook"]);
    for (const r of rows) expect(r.conv_id).toBe(CONV);
  });

  test("a surface-once overlay is visible — the regression this projection exists for", () => {
    // `skills__loading_log` previously hard-filtered `ev.type !== "skills.loaded"`,
    // so a conversation whose only guidance came from an overlay read as empty.
    const rows = projectSkillLoads(CONV, [connectorInjected("2026-08-01T00:00:00Z")]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      skill: "gmail-usage",
      loaded_by: "tool_use",
      tool_name: "gmail__send",
      scope: "connector",
    });
  });

  test("an overlay's tokens are measured from the body it carries", () => {
    // The event records no token count, so the projection measures the body —
    // through the same estimator skills.loaded counts with, so a token column
    // summed across channels means one thing.
    const rows = projectSkillLoads(CONV, [
      connectorInjected("2026-08-01T00:00:00Z", { skillBody: "y".repeat(400) }),
    ]);
    expect(rows[0]?.tokens).toBe(100);
  });

  test("ignores events that are not skill loads", () => {
    const rows = projectSkillLoads(CONV, [
      { ts: "2026-08-01T00:00:00Z", type: "run.done", runId: "run-1" } as ConversationEvent,
      { ts: "2026-08-01T00:00:01Z", type: "metadata.title", title: "hi" } as ConversationEvent,
    ]);
    expect(rows).toEqual([]);
  });
});

describe("projectSkillLoads — shape", () => {
  test("a run-shaped skills.loaded fans out to one row per skill", () => {
    const rows = projectSkillLoads(CONV, [
      skillsLoaded("2026-08-01T00:00:00Z", "run-1", [
        entry({ id: "/skills/voice.md", name: "voice" }),
        entry({ id: "/skills/tone.md", name: "tone", loadedBy: "tool_affinity", tokens: 80 }),
      ]),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.skill)).toEqual(["voice", "tone"]);
    expect(rows.map((r) => r.loaded_by)).toEqual(["always", "tool_affinity"]);
    // Both inherit the run they composed in.
    for (const r of rows) expect(r.run_id).toBe("run-1");
  });

  test("a skills.loaded entry predating the name field falls back to its id", () => {
    const rows = projectSkillLoads(CONV, [
      skillsLoaded("2026-08-01T00:00:00Z", "run-1", [entry({ name: undefined })]),
    ]);
    expect(rows[0]?.skill).toBe("/skills/voice.md");
    expect(rows[0]?.skill_id).toBe("/skills/voice.md");
  });

  test("only prompt-composed rows carry a skill_id", () => {
    const rows = projectSkillLoads(CONV, [
      skillsLoaded("2026-08-01T00:00:00Z", "run-1", [entry()]),
      connectorInjected("2026-08-01T00:01:00Z"),
      activated("2026-08-01T00:02:00Z"),
    ]);
    expect(rows[0]?.skill_id).toBe("/skills/voice.md");
    expect(rows[1]?.skill_id).toBeUndefined();
    expect(rows[2]?.skill_id).toBeUndefined();
  });

  test("an overlay carries no run id, because the event records none", () => {
    const rows = projectSkillLoads(CONV, [connectorInjected("2026-08-01T00:00:00Z")]);
    expect(rows[0]?.run_id).toBeUndefined();
  });

  test("carries the publishing connector when the record names one", () => {
    const rows = projectSkillLoads(CONV, [
      skillsLoaded("2026-08-01T00:00:00Z", "run-1", [entry({ connector: "gmail" })]),
    ]);
    expect(rows[0]?.connector).toBe("gmail");
  });

  test("preserves event order, oldest first", () => {
    const rows = projectSkillLoads(CONV, [
      activated("2026-08-01T00:00:00Z"),
      connectorInjected("2026-08-01T00:00:01Z"),
    ]);
    expect(rows.map((r) => r.ts)).toEqual(["2026-08-01T00:00:00Z", "2026-08-01T00:00:01Z"]);
  });
});
