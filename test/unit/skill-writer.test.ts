import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeSkill,
  readSkill,
  updateSkill,
  deleteSkill,
  listSkills,
  SkillFrontmatterValidationError,
} from "../../src/skills/writer.ts";
import { parseSkillContent } from "../../src/skills/loader.ts";
import type { SkillManifest } from "../../src/skills/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-writer-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleManifest(overrides?: Partial<SkillManifest>): SkillManifest {
  return {
    name: "test-skill",
    description: "A test skill",
    loadingStrategy: "dynamic",
    priority: 50,
    status: "active",
    allowedTools: ["bash__*", "nb__*"],
    triggers: ["run test"],
    ...overrides,
  };
}

describe("writeSkill", () => {
  test("creates a file that parseSkillContent can read back identically", () => {
    const manifest = sampleManifest();
    const body = "You are a helpful test skill.\n\nDo testing things.";

    writeSkill(dir, "test-skill", manifest, body);

    const filePath = join(dir, "test-skill.md");
    expect(existsSync(filePath)).toBe(true);

    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseSkillContent(raw, filePath);
    expect(parsed).not.toBeNull();
    expect(parsed!.manifest.name).toBe(manifest.name);
    expect(parsed!.manifest.description).toBe(manifest.description);
    expect(parsed!.manifest.loadingStrategy).toBe(manifest.loadingStrategy);
    expect(parsed!.manifest.priority).toBe(manifest.priority);
    expect(parsed!.manifest.allowedTools).toEqual(manifest.allowedTools);
    expect(parsed!.manifest.triggers).toEqual(manifest.triggers);
    expect(parsed!.body).toBe(body);
  });

  test("creates directory if it does not exist", () => {
    const nested = join(dir, "a", "b", "c");
    writeSkill(nested, "deep", sampleManifest({ name: "deep" }), "body");
    expect(existsSync(join(nested, "deep.md"))).toBe(true);
  });

  test("omits empty arrays from frontmatter", () => {
    const manifest = sampleManifest({
      allowedTools: [],
      triggers: [],
    });
    writeSkill(dir, "empty-arrays", manifest, "body");

    const raw = readFileSync(join(dir, "empty-arrays.md"), "utf-8");
    expect(raw).not.toContain("allowed-tools");
  });

  test("never persists the in-memory 'vendored' origin (loader-owned marker)", () => {
    // markVendored stamps origin "vendored" in memory; writing such a manifest
    // to disk drops the marker, so the file carries no provenance and reloads
    // cleanly — the on-disk schema rejects a hand-authored "vendored" origin.
    const manifest = sampleManifest({
      name: "authored-copy",
      provenance: { origin: "vendored" },
    });
    writeSkill(dir, "authored-copy", manifest, "body");

    const raw = readFileSync(join(dir, "authored-copy.md"), "utf-8");
    expect(raw).not.toContain("vendored");
    expect(raw).not.toContain("provenance");

    const reread = readSkill(dir, "authored-copy");
    expect(reread).not.toBeNull();
    expect(reread!.manifest.provenance).toBeUndefined();
  });

  test("refuses to write a manifest the loader would reject — no orphan file", () => {
    // Empty description fails the canonical schema (minLength 1). The write
    // must throw BEFORE touching disk, so a "failed" create leaves nothing
    // behind for a retry to collide with.
    const manifest = sampleManifest({ name: "orphan", description: "" });
    expect(() => writeSkill(dir, "orphan", manifest, "body")).toThrow(
      SkillFrontmatterValidationError,
    );
    expect(existsSync(join(dir, "orphan.md"))).toBe(false);
  });
});

describe("readSkill", () => {
  test("returns null for non-existent file", () => {
    expect(readSkill(dir, "nope")).toBeNull();
  });

  test("returns parsed skill for valid file", () => {
    writeSkill(dir, "readable", sampleManifest({ name: "readable" }), "hello");
    const skill = readSkill(dir, "readable");
    expect(skill).not.toBeNull();
    expect(skill!.manifest.name).toBe("readable");
    expect(skill!.body).toBe("hello");
  });
});

describe("updateSkill", () => {
  test("with partial manifest preserves other fields", () => {
    const manifest = sampleManifest();
    writeSkill(dir, "test-skill", manifest, "original body");

    updateSkill(dir, "test-skill", { description: "Updated description" });

    const skill = readSkill(dir, "test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.manifest.description).toBe("Updated description");
    // Other fields preserved
    expect(skill!.manifest.name).toBe("test-skill");
    expect(skill!.manifest.loadingStrategy).toBe("dynamic");
    expect(skill!.manifest.priority).toBe(50);
    expect(skill!.manifest.allowedTools).toEqual(["bash__*", "nb__*"]);
    expect(skill!.body).toBe("original body");
  });

  test("with new body replaces body but keeps manifest", () => {
    const manifest = sampleManifest();
    writeSkill(dir, "test-skill", manifest, "original body");

    updateSkill(dir, "test-skill", undefined, "new body content");

    const skill = readSkill(dir, "test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.body).toBe("new body content");
    expect(skill!.manifest.name).toBe("test-skill");
    expect(skill!.manifest.description).toBe("A test skill");
  });

  test("throws if skill does not exist", () => {
    expect(() => updateSkill(dir, "ghost", { description: "nope" })).toThrow(
      /Skill "ghost" not found/,
    );
  });
});

describe("deleteSkill", () => {
  test("removes the file", () => {
    writeSkill(dir, "doomed", sampleManifest({ name: "doomed" }), "goodbye");
    expect(existsSync(join(dir, "doomed.md"))).toBe(true);

    deleteSkill(dir, "doomed");
    expect(existsSync(join(dir, "doomed.md"))).toBe(false);
  });

  test("subsequent readSkill returns null", () => {
    writeSkill(dir, "doomed", sampleManifest({ name: "doomed" }), "goodbye");
    deleteSkill(dir, "doomed");
    expect(readSkill(dir, "doomed")).toBeNull();
  });

  test("no-op if file does not exist", () => {
    // Should not throw
    deleteSkill(dir, "nonexistent");
  });
});

describe("listSkills", () => {
  test("returns empty array for non-existent directory", () => {
    expect(listSkills(join(dir, "nope"))).toEqual([]);
  });

  test("returns empty array for empty directory", () => {
    expect(listSkills(dir)).toEqual([]);
  });

  test("returns all parsed skills from directory", () => {
    writeSkill(dir, "alpha", sampleManifest({ name: "alpha" }), "body a");
    writeSkill(dir, "beta", sampleManifest({ name: "beta" }), "body b");
    writeSkill(dir, "gamma", sampleManifest({ name: "gamma" }), "body c");

    const skills = listSkills(dir);
    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.manifest.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  test("skips non-md files", () => {
    writeSkill(dir, "valid", sampleManifest({ name: "valid" }), "body");
    writeFileSync(join(dir, "readme.txt"), "not a skill");

    const skills = listSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].manifest.name).toBe("valid");
  });
});

describe("atomic write safety", () => {
  test("original file is not corrupted if write is to temp first", () => {
    // Write an initial file
    writeSkill(dir, "safe", sampleManifest({ name: "safe" }), "original");

    // Verify the file exists and is valid
    const before = readSkill(dir, "safe");
    expect(before).not.toBeNull();
    expect(before!.body).toBe("original");

    // Overwrite with new content (this goes through temp file)
    writeSkill(dir, "safe", sampleManifest({ name: "safe" }), "updated");

    const after = readSkill(dir, "safe");
    expect(after).not.toBeNull();
    expect(after!.body).toBe("updated");

    // Verify no .tmp file is left behind
    expect(existsSync(join(dir, "safe.md.tmp"))).toBe(false);
  });
});

describe("updateSkill provenance", () => {
  test("bumps updated-at while preserving created-at / created-by / origin", () => {
    const old = "2020-01-01T00:00:00.000Z";
    writeSkill(
      dir,
      "prov",
      sampleManifest({
        name: "prov",
        provenance: { origin: "chat", createdBy: "usr_x", createdAt: old, updatedAt: old },
      }),
      "body",
    );
    updateSkill(dir, "prov", { description: "edited" });
    const after = readSkill(dir, "prov");
    expect(after?.manifest.provenance?.createdAt).toBe(old); // preserved
    expect(after?.manifest.provenance?.createdBy).toBe("usr_x"); // preserved
    expect(after?.manifest.provenance?.origin).toBe("chat"); // preserved
    expect(after?.manifest.provenance?.updatedAt).not.toBe(old); // bumped to now
  });
});
