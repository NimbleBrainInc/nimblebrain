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
  ContextAssembledPayload,
  DataChangedPayload,
  FileCreatedPayload,
  FileDeletedPayload,
  SkillCreatedPayload,
  SkillDeletedPayload,
  SkillsLoadedPayload,
  SkillUpdatedPayload,
} from "../../src/engine/schemas/events.ts";

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

  test("skill.updated — move_scope variant", () => {
    expect(
      Value.Check(SkillUpdatedPayload, {
        id: "/data/skills/foo.md",
        name: "foo",
        scope: "org",
        action: "move_scope",
        from: "workspace",
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
