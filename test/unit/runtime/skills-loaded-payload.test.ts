import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildSkillsLoadedPayload,
  hashSkillBody,
} from "../../../src/runtime/skills-loaded-payload.ts";
import type { SelectedSkill } from "../../../src/skills/select.ts";

function selected(overrides: Partial<SelectedSkill["skill"]>, loadedBy: "always" | "tool_affinity" = "always"): SelectedSkill {
  return {
    skill: {
      manifest: {
        name: "test-skill",
        description: "A test skill",
        version: "1.0.0",
        type: "context",
        priority: 50,
        ...(overrides.manifest ?? {}),
      },
      body: overrides.body ?? "Default body content.",
      sourcePath: overrides.sourcePath ?? "",
    },
    loadedBy,
    reason: loadedBy === "always" ? "loading_strategy: always" : "applies_to_tools matched foo__*",
  };
}

describe("hashSkillBody", () => {
  test("returns SHA-256 hex of the body string", () => {
    const body = "Always use patch_source for revisions.";
    const expected = createHash("sha256").update(body).digest("hex");
    expect(hashSkillBody(body)).toBe(expected);
  });

  test("is deterministic — same input, same hash", () => {
    const body = "Voice rule: no em-dashes in user-facing copy.";
    expect(hashSkillBody(body)).toBe(hashSkillBody(body));
  });

  test("hashes the empty string to a known sentinel", () => {
    // Cheap canary that catches any future regression in the digest pipeline:
    // SHA-256("") is a well-known constant.
    expect(hashSkillBody("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("a single-byte change in the body produces a completely different hash", () => {
    const a = hashSkillBody("Use patch_source for revisions.");
    const b = hashSkillBody("Use set_source for revisions.");
    expect(a).not.toBe(b);
    // SHA-256 should differ in roughly half the bits — assert non-trivial difference.
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diff++;
    }
    expect(diff).toBeGreaterThan(20);
  });
});

describe("buildSkillsLoadedPayload", () => {
  test("populates contentHash on every entry", () => {
    const payload = buildSkillsLoadedPayload([
      selected({ body: "Body one." }),
      selected({ body: "Body two — entirely different." }, "tool_affinity"),
    ]);
    expect(payload.skills).toHaveLength(2);
    expect(payload.skills[0]!.contentHash).toBe(hashSkillBody("Body one."));
    expect(payload.skills[1]!.contentHash).toBe(hashSkillBody("Body two — entirely different."));
  });

  test("contentHash differs for skills with different bodies even if names match", () => {
    // Two skills with the same name but different bodies (e.g. one was edited
    // mid-session) must produce different hashes — that's the whole point of
    // the field. This guards against any future code path that hashes by id
    // or path instead of content.
    const a = buildSkillsLoadedPayload([selected({ body: "version A" })]);
    const b = buildSkillsLoadedPayload([selected({ body: "version B" })]);
    expect(a.skills[0]!.contentHash).not.toBe(b.skills[0]!.contentHash);
  });

  test("sums per-skill tokens into totalTokens", () => {
    const payload = buildSkillsLoadedPayload([
      selected({ body: "short" }),
      selected({ body: "this body is materially longer than the first one for sure" }),
    ]);
    expect(payload.totalTokens).toBe(
      payload.skills.reduce((sum, s) => sum + s.tokens, 0),
    );
  });

  test("uses the in-memory sentinel id for skills without a sourcePath", () => {
    const payload = buildSkillsLoadedPayload([
      selected({ sourcePath: "", manifest: { name: "synthesized" } }),
    ]);
    expect(payload.skills[0]!.id).toBe("skill-in-memory:synthesized");
    expect(payload.skills[0]!.version).toBe("");
    // Hash is still computed even for in-memory skills.
    expect(payload.skills[0]!.contentHash).toBeTruthy();
  });

  test("propagates loadedBy and reason from the selector", () => {
    const payload = buildSkillsLoadedPayload([
      selected({ body: "x" }, "always"),
      selected({ body: "y" }, "tool_affinity"),
    ]);
    expect(payload.skills[0]!.loadedBy).toBe("always");
    expect(payload.skills[0]!.reason).toContain("loading_strategy");
    expect(payload.skills[1]!.loadedBy).toBe("tool_affinity");
    expect(payload.skills[1]!.reason).toContain("applies_to_tools");
  });
});
