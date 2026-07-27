/**
 * Tests for `src/engine/schemas/events.ts` — the typed payload schemas
 * for SSE events. These schemas are the declarative source of truth for
 * the wire shape of each named event; today they aren't enforced at the
 * EngineEvent level (consumer narrowing isn't yet wired), but they're
 * available for any code that wants the precise type or runtime check.
 *
 * The tests below exercise representative payloads so future drift in
 * the schemas (or the producer interfaces they mirror) surfaces here.
 */
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import {
  ConnectorSkillInjectedPayload,
  ContextAssembledPayload,
  DataChangedPayload,
  FileCreatedPayload,
  FileDeletedPayload,
  SkillCreatedPayload,
  SkillDeletedPayload,
  SkillsLoadedPayload,
  SkillUpdatedPayload,
  ToolPromotionChangedPayload,
} from "../../src/engine/schemas/events.ts";
import { buildContextAssembledPayload } from "../../src/runtime/runtime.ts";
import { buildSkillsLoadedPayload } from "../../src/runtime/skills-loaded-payload.ts";
import { synthesizeBundleSkill } from "../../src/skills/bundle-skills.ts";
import type { Skill, SkillScope } from "../../src/skills/types.ts";

describe("event schemas — accept representative payloads", () => {
  test("skills.loaded — full payload with runId", () => {
    const payload = {
      runId: "run-abc",
      skills: [
        {
          id: "/data/skills/foo.md",
          layer: 3 as const,
          scope: "workspace" as const,
          version: "1.0.0",
          tokens: 42,
          contentHash: "deadbeef",
          loadedBy: "always" as const,
          reason: "always-on context",
        },
      ],
      totalTokens: 42,
    };
    expect(Value.Check(SkillsLoadedPayload, payload)).toBe(true);
  });

  test("context.assembled — minimal payload + headroom", () => {
    const payload = {
      sources: [{ kind: "skills", tokens: 100 }],
      excluded: [],
      totalTokens: 100,
      modelMaxContext: 200000,
      headroomTokens: 199900,
    };
    expect(Value.Check(ContextAssembledPayload, payload)).toBe(true);
  });

  test("data.changed — agent-emitted variant", () => {
    expect(
      Value.Check(DataChangedPayload, {
        source: "agent",
        server: "skills",
        tool: "create",
      }),
    ).toBe(true);
  });

  test("data.changed — runtime-emitted variant (no source)", () => {
    expect(Value.Check(DataChangedPayload, { server: "conversations", tool: "list" })).toBe(true);
  });

  test("skill.created — required fields", () => {
    expect(
      Value.Check(SkillCreatedPayload, {
        id: "/data/skills/foo.md",
        name: "foo",
        scope: "workspace",
        type: "skill",
      }),
    ).toBe(true);
  });

  test("skill.updated — bare update", () => {
    expect(
      Value.Check(SkillUpdatedPayload, {
        id: "/data/skills/foo.md",
        name: "foo",
        scope: "workspace",
      }),
    ).toBe(true);
  });

  test("skill.deleted — required fields", () => {
    expect(
      Value.Check(SkillDeletedPayload, {
        id: "/data/skills/foo.md",
        name: "foo",
        scope: "user",
      }),
    ).toBe(true);
  });

  test("file.created / file.deleted — basic shapes", () => {
    expect(
      Value.Check(FileCreatedPayload, {
        id: "file-abc",
        filename: "logo.png",
        mimeType: "image/png",
        size: 1024,
      }),
    ).toBe(true);
    expect(Value.Check(FileDeletedPayload, { id: "file-abc" })).toBe(true);
  });

  test("tool.promoted / tool.released — basic shape", () => {
    expect(
      Value.Check(ToolPromotionChangedPayload, { runId: "run-abc", toolName: "app__tool" }),
    ).toBe(true);
  });

  test("tool.released — accepts optional reason for engine-driven evictions", () => {
    expect(
      Value.Check(ToolPromotionChangedPayload, {
        runId: "run-abc",
        toolName: "app__tool",
        reason: "evicted",
      }),
    ).toBe(true);
  });

  test("connector.skill.injected — full payload", () => {
    expect(
      Value.Check(ConnectorSkillInjectedPayload, {
        runId: "run-abc",
        toolName: "gmail__send",
        skillName: "gmail",
        skillBody: "Confirm the recipient before sending.",
        scope: "connector",
      }),
    ).toBe(true);
  });
});

describe("event schemas — reject malformed payloads", () => {
  test("skills.loaded — rejects entry missing contentHash", () => {
    const payload = {
      skills: [
        {
          id: "/data/skills/foo.md",
          layer: 3 as const,
          scope: "workspace" as const,
          version: "1.0.0",
          tokens: 42,
          loadedBy: "always" as const,
          reason: "always-on",
        },
      ],
      totalTokens: 42,
    };
    expect(Value.Check(SkillsLoadedPayload, payload)).toBe(false);
  });

  test("data.changed — rejects without server/tool", () => {
    expect(Value.Check(DataChangedPayload, { source: "agent" })).toBe(false);
  });

  test("skill.created — rejects scope=bundle (writable scopes only)", () => {
    expect(
      Value.Check(SkillCreatedPayload, {
        id: "/x.md",
        name: "x",
        scope: "bundle",
        type: "skill",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drift: the schemas vs. what the emitters actually produce.
//
// The fixtures above are hand-written, and `Type.Object` accepts unknown
// properties, so a payload the schema fails to describe still passes them —
// the schema can go stale on a field and nothing here notices. These run the
// real builders and check their output, so the declaration cannot silently
// fall behind the emitter.
// ---------------------------------------------------------------------------

describe("event schemas — accept what the emitters produce", () => {
  const skill = (
    name: string,
    over: Partial<{ scope: SkillScope; sourcePath: string }> = {},
  ): Skill => ({
    manifest: {
      name,
      description: `${name} desc`,
      loadingStrategy: "always",
      priority: 50,
      status: "active",
      scope: over.scope ?? "org",
    },
    body: `body of ${name}`,
    sourcePath: over.sourcePath ?? "",
  });

  test("skills.loaded — every loading mechanism, including a connector skill", () => {
    const published = synthesizeBundleSkill({
      serverName: "acme-mcp",
      skillName: "billing",
      description: "",
      body: "Charge carefully.",
      uri: "skill://acme/billing/SKILL.md",
    });
    const payload = buildSkillsLoadedPayload([
      { skill: skill("always-on"), loadedBy: "always", reason: "always-on" },
      { skill: published, loadedBy: "tool_affinity", reason: "tool-affinity matched acme-mcp__*" },
      { skill: skill("triggered"), loadedBy: "trigger", reason: 'trigger matched "deploy"' },
    ]);

    // Guard the guard: these are the values that must reach the checker, and
    // they are exactly what the schema used to be too narrow to admit.
    expect(payload.skills.map((s) => s.layer).sort()).toEqual([0, 3, 4]);
    expect(payload.skills[1]!.connector).toBe("acme-mcp");
    expect(Value.Check(SkillsLoadedPayload, payload)).toBe(true);
    expect([...Value.Errors(SkillsLoadedPayload, payload)]).toHaveLength(0);
  });

  test("context.assembled — the recorded source rows", () => {
    const payload = buildContextAssembledPayload({
      systemPrompt: "You are helpful.",
      activeTools: [
        { name: "nb__search", description: "Search", inputSchema: { type: "object" } },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      skillsLoaded: buildSkillsLoadedPayload([
        { skill: skill("always-on"), loadedBy: "always", reason: "always-on" },
      ]),
    });

    expect(payload.sources.find((s) => s.kind === "history")?.messages).toBeGreaterThan(0);
    expect(Value.Check(ContextAssembledPayload, payload)).toBe(true);
    expect([...Value.Errors(ContextAssembledPayload, payload)]).toHaveLength(0);
  });
});
