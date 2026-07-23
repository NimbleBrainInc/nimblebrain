import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildSkillsLoadedPayload,
  collectLoadedSkills,
  hashSkillBody,
} from "../../../src/runtime/skills-loaded-payload.ts";
import type { Skill } from "../../../src/skills/types.ts";
import type { LoadedBy, SelectedSkill } from "../../../src/skills/select.ts";

function makeSkill(
  name: string,
  opts: {
    strategy?: "always" | "dynamic";
    scope?: "org" | "workspace" | "user" | "bundle";
    sourcePath?: string;
    body?: string;
    vendored?: boolean;
  } = {},
): Skill {
  return {
    manifest: {
      name,
      description: `${name} desc`,
      loadingStrategy: opts.strategy ?? "always",
      priority: 50,
      status: "active",
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.vendored ? { provenance: { origin: "vendored" } } : {}),
    },
    body: opts.body ?? `body of ${name}`,
    sourcePath: opts.sourcePath ?? "",
  };
}

function selected(overrides: Partial<SelectedSkill["skill"]>, loadedBy: LoadedBy = "always"): SelectedSkill {
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

  test("derives the mechanism layer from loadedBy (always=0, tool_affinity=3, trigger=4)", () => {
    const payload = buildSkillsLoadedPayload([
      selected({ body: "a" }, "always"),
      selected({ body: "b" }, "tool_affinity"),
      { skill: makeSkill("t", { strategy: "dynamic" }), loadedBy: "trigger", reason: 'trigger matched "x"' },
    ]);
    expect(payload.skills.map((s) => s.layer)).toEqual([0, 3, 4]);
  });
});

describe("collectLoadedSkills", () => {
  test("reports tool-affinity, trigger, and always-on with the right loadedBy + reason", () => {
    const out = collectLoadedSkills({
      toolAffinity: [
        {
          skill: makeSkill("mpak-guide", { strategy: "dynamic", sourcePath: "/s/mpak.md" }),
          loadedBy: "tool_affinity",
          reason: "tool-affinity matched mpak__*",
        },
      ],
      trigger: { skill: makeSkill("deploy-guide", { strategy: "dynamic", sourcePath: "/s/deploy.md" }), trigger: "deploy" },
      alwaysOn: [makeSkill("house-style", { sourcePath: "/s/house.md" })],
    });
    expect(out.map((s) => [s.skill.manifest.name, s.loadedBy])).toEqual([
      ["mpak-guide", "tool_affinity"],
      ["deploy-guide", "trigger"],
      ["house-style", "always"],
    ]);
    expect(out[1]!.reason).toBe('trigger matched "deploy"');
    expect(out[2]!.reason).toBe("always-on");
  });

  test("excludes vendored platform-core always-on skills (soul/capabilities)", () => {
    const out = collectLoadedSkills({
      toolAffinity: [],
      alwaysOn: [
        makeSkill("soul", { vendored: true, sourcePath: "/core/soul.md" }),
        makeSkill("house-style", { sourcePath: "/s/house.md" }),
      ],
    });
    expect(out.map((s) => s.skill.manifest.name)).toEqual(["house-style"]);
  });

  test("keeps a non-vendored always-on skill with no sourcePath (workspace persona override)", () => {
    const out = collectLoadedSkills({
      toolAffinity: [],
      alwaysOn: [makeSkill("identity-override", { sourcePath: "" })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.loadedBy).toBe("always");
  });

  test("dedupes a skill matched by both tool-affinity and trigger — tool-affinity wins", () => {
    const dual = makeSkill("dual", { strategy: "dynamic", sourcePath: "/s/dual.md" });
    const out = collectLoadedSkills({
      toolAffinity: [{ skill: dual, loadedBy: "tool_affinity", reason: "tool-affinity matched x__*" }],
      trigger: { skill: dual, trigger: "x" },
      alwaysOn: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.loadedBy).toBe("tool_affinity");
  });

  test("no trigger and no always-on collapses to just tool-affinity", () => {
    const out = collectLoadedSkills({
      toolAffinity: [
        { skill: makeSkill("only", { strategy: "dynamic" }), loadedBy: "tool_affinity", reason: "r" },
      ],
      alwaysOn: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.loadedBy).toBe("tool_affinity");
  });
});
