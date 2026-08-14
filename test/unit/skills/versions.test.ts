/**
 * Snapshot history and append-mode body writes.
 *
 * The regression these guard: `updateSkill` replaced the whole body on every
 * call, so an "add this rule" edit discarded the rest of the skill — and the
 * `_versions/` snapshot that would have saved it was unreachable, because
 * nothing could list or read that directory. Both halves are covered here:
 * append composes instead of overwriting, and the history is enumerable,
 * readable, and restorable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  joinSkillBody,
  readSkill,
  updateSkill,
  writeSkill,
} from "../../../src/skills/writer.ts";
import {
  listSkillVersions,
  readSkillVersionRaw,
  snapshotSkillVersion,
  versionFilePath,
  versionsDirFor,
} from "../../../src/skills/versions.ts";
import { parseSkillContent } from "../../../src/skills/loader.ts";
import type { SkillManifest } from "../../../src/skills/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-versions-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manifest(overrides?: Partial<SkillManifest>): SkillManifest {
  return {
    name: "rules",
    description: "House rules",
    loadingStrategy: "always",
    priority: 50,
    status: "active",
    ...overrides,
  };
}

const ORIGINAL = "## Rule one\n\nAlways cite a source.";
const ADDITION = "## Rule two\n\nNever invent a number.";

function livePath(name = "rules"): string {
  return join(dir, `${name}.md`);
}

describe("joinSkillBody", () => {
  test("separates parts with exactly one blank line", () => {
    expect(joinSkillBody("a", "b")).toBe("a\n\nb");
  });

  test("does not accumulate blank lines across repeated appends", () => {
    const once = joinSkillBody(ORIGINAL, ADDITION);
    const twice = joinSkillBody(once, "## Rule three\n\nShow your work.");
    expect(twice).not.toContain("\n\n\n");
  });

  test("preserves interior formatting on both sides", () => {
    const fenced = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(joinSkillBody(fenced, "after")).toBe(`${fenced}\n\nafter`);
    expect(joinSkillBody("before", fenced)).toBe(`before\n\n${fenced}`);
  });

  test("appending to an empty body yields just the addition", () => {
    expect(joinSkillBody("", ADDITION)).toBe(ADDITION);
    expect(joinSkillBody("   \n\n", ADDITION)).toBe(ADDITION);
  });
});

describe("updateSkill body modes", () => {
  test("append keeps the existing body and adds the new section", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    updateSkill(dir, "rules", undefined, ADDITION, "append");

    const after = readSkill(dir, "rules");
    expect(after?.body).toContain("Always cite a source.");
    expect(after?.body).toContain("Never invent a number.");
  });

  test("append twice keeps all three sections, frontmatter written once", async () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    updateSkill(dir, "rules", undefined, ADDITION, "append");
    updateSkill(dir, "rules", undefined, "## Rule three\n\nShow your work.", "append");

    const after = readSkill(dir, "rules");
    expect(after?.body).toContain("Always cite a source.");
    expect(after?.body).toContain("Never invent a number.");
    expect(after?.body).toContain("Show your work.");
    expect(after?.manifest.name).toBe("rules");
    // Exactly one frontmatter block survives the round trip.
    const text = await Bun.file(livePath()).text();
    expect(text.split("---").length - 1).toBe(2);
  });

  test("replace overwrites the whole body — the destructive path, explicit", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    updateSkill(dir, "rules", undefined, ADDITION, "replace");

    const after = readSkill(dir, "rules");
    expect(after?.body).not.toContain("Always cite a source.");
    expect(after?.body).toContain("Never invent a number.");
  });

  test("defaults to replace when no mode is given (the tool layer requires one)", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    updateSkill(dir, "rules", undefined, ADDITION);
    expect(readSkill(dir, "rules")?.body).not.toContain("Always cite a source.");
  });

  test("a manifest-only patch leaves the body untouched in either mode", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    updateSkill(dir, "rules", { description: "Renamed" }, undefined, "append");
    const after = readSkill(dir, "rules");
    expect(after?.body).toBe(ORIGINAL);
    expect(after?.manifest.description).toBe("Renamed");
  });
});

describe("version history", () => {
  test("snapshot then list returns the version, newest first", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    const v1 = snapshotSkillVersion(livePath());
    expect(v1).toBeTruthy();

    const versions = listSkillVersions(livePath());
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(v1);
    expect(versions[0]?.bytes).toBeGreaterThan(0);
    // savedAt is a real instant derived from the filename stamp.
    expect(Number.isNaN(Date.parse(versions[0]?.savedAt ?? ""))).toBe(false);
  });

  test("snapshotting a missing file is a no-op, not an error", () => {
    expect(snapshotSkillVersion(livePath("absent"))).toBeNull();
    expect(listSkillVersions(livePath("absent"))).toEqual([]);
  });

  test("history is empty, not an error, before anything is snapshotted", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    expect(listSkillVersions(livePath())).toEqual([]);
  });

  test("a snapshot round-trips the exact bytes that were live", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    const version = snapshotSkillVersion(livePath()) as string;
    updateSkill(dir, "rules", undefined, "clobbered", "replace");

    const raw = readSkillVersionRaw(livePath(), version) as string;
    expect(raw).toContain("Always cite a source.");
    expect(readSkill(dir, "rules")?.body).toBe("clobbered");
  });

  test("one skill's history never includes a same-prefixed sibling's", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    writeSkill(dir, "rules-extra", manifest({ name: "rules-extra" }), "Other content");
    snapshotSkillVersion(livePath("rules"));
    snapshotSkillVersion(livePath("rules-extra"));

    expect(listSkillVersions(livePath("rules"))).toHaveLength(1);
    expect(listSkillVersions(livePath("rules-extra"))).toHaveLength(1);
    // Both snapshots really are in the one shared directory.
    expect(readdirSync(versionsDirFor(livePath())).length).toBe(2);
  });

  test("a foreign file in _versions/ is skipped rather than listed with a guessed date", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    snapshotSkillVersion(livePath());
    writeFileSync(join(versionsDirFor(livePath()), "rules.not-a-stamp.md"), "junk");

    const versions = listSkillVersions(livePath());
    expect(versions).toHaveLength(1);
    expect(versions.every((v) => !Number.isNaN(Date.parse(v.savedAt)))).toBe(true);
  });

  test("reading an unknown version returns null rather than throwing", () => {
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    expect(readSkillVersionRaw(livePath(), "2026-01-01T00-00-00-000Z")).toBeNull();
    expect(existsSync(versionFilePath(livePath(), "nope"))).toBe(false);
  });
});

describe("restore round trip", () => {
  test("a replace that discarded content is recoverable from history", () => {
    // The incident, reproduced: full body, then an "add a rule" edit that
    // replaced instead of appended.
    writeSkill(dir, "rules", manifest(), ORIGINAL);
    const version = snapshotSkillVersion(livePath()) as string;
    updateSkill(dir, "rules", undefined, ADDITION, "replace");
    expect(readSkill(dir, "rules")?.body).not.toContain("Always cite a source.");

    // Recovery: read the snapshot back and write it live.
    const raw = readSkillVersionRaw(livePath(), version) as string;
    const parsed = parseSkillContent(raw, livePath(), { cap: false });
    if (!parsed) throw new Error("snapshot did not parse");
    writeSkill(dir, "rules", parsed.manifest, parsed.body);

    expect(readSkill(dir, "rules")?.body).toContain("Always cite a source.");
  });
});
