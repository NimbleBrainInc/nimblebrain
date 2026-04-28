/**
 * Phase 2 — multi-scope skill discovery.
 *
 * Verifies:
 *   - `loadScopedSkills(dir, scope)` stamps `manifest.scope` on every
 *     returned skill.
 *   - Reserved subdirs (`_versions/`, `_archived/`, anything starting with
 *     "_") are skipped.
 *   - Nested `bundles/<bundle>/<skill>.md` is discovered with the parent
 *     scope stamped.
 *   - Missing directories return `[]` without throwing.
 *   - The pure merge helper (`mergeScopedSkills`) layers user > workspace
 *     > org on `manifest.name` collisions.
 *
 * The merge logic is exercised through the pure helper so we don't have to
 * spin up a full `Runtime.start()` (which pulls in identity providers,
 * bundle lifecycle, etc. — overkill for this unit). The runtime method
 * `Runtime.loadConversationSkills` is a thin orchestrator over
 * `loadScopedSkills` + `mergeScopedSkills`; integration coverage of the
 * combined path lives in higher-tier tests once Task 003 wires it into
 * the engine.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadScopedSkills, mergeScopedSkills } from "../../../src/skills/loader.ts";
import type { Skill } from "../../../src/skills/types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-scope-discovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkillFile(path: string, name: string, type: "context" | "skill" = "skill"): void {
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: ${name}\nversion: 1.0.0\ntype: ${type}\npriority: 50\n---\nBody for ${name}.\n`,
    "utf-8",
  );
}

describe("loadScopedSkills — stamping", () => {
  test("stamps manifest.scope on every returned skill", () => {
    const dir = join(root, "org-dir");
    mkdirSync(dir, { recursive: true });
    writeSkillFile(join(dir, "alpha.md"), "alpha");
    writeSkillFile(join(dir, "beta.md"), "beta", "context");

    const skills = loadScopedSkills(dir, "org");
    expect(skills).toHaveLength(2);
    for (const s of skills) {
      expect(s.manifest.scope).toBe("org");
    }

    // Same content, different scope → re-stamped accordingly.
    const asWorkspace = loadScopedSkills(dir, "workspace");
    for (const s of asWorkspace) {
      expect(s.manifest.scope).toBe("workspace");
    }
  });

  test("frontmatter scope is overwritten by the dir-stamped scope", () => {
    const dir = join(root, "stamp-precedence");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "claims-bundle.md"),
      `---\nname: claims-bundle\ndescription: x\nversion: 1.0.0\ntype: skill\npriority: 50\nscope: bundle\n---\nBody.\n`,
      "utf-8",
    );

    const skills = loadScopedSkills(dir, "user");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.manifest.scope).toBe("user");
  });
});

describe("loadScopedSkills — subdir handling", () => {
  test("skips reserved subdirs (_versions, _archived, _anything)", () => {
    const dir = join(root, "skips");
    mkdirSync(dir, { recursive: true });
    writeSkillFile(join(dir, "live.md"), "live");
    writeSkillFile(join(dir, "_versions", "old.md"), "old-versioned");
    writeSkillFile(join(dir, "_archived", "ancient.md"), "ancient");
    writeSkillFile(join(dir, "_secrets", "hidden.md"), "hidden");

    const skills = loadScopedSkills(dir, "workspace");
    const names = skills.map((s) => s.manifest.name).sort();
    expect(names).toEqual(["live"]);
  });

  test("discovers nested bundles/<bundle>/<skill>.md with the parent scope", () => {
    const dir = join(root, "with-bundles");
    mkdirSync(dir, { recursive: true });
    writeSkillFile(join(dir, "top-level.md"), "top-level");
    writeSkillFile(join(dir, "bundles", "synapse-collateral", "patch-policy.md"), "patch-policy");
    writeSkillFile(join(dir, "bundles", "another-bundle", "voice.md"), "voice");

    const skills = loadScopedSkills(dir, "workspace");
    const names = skills.map((s) => s.manifest.name).sort();
    expect(names).toEqual(["patch-policy", "top-level", "voice"]);
    for (const s of skills) {
      expect(s.manifest.scope).toBe("workspace");
    }
  });

  test("recurses to depth 2 (bundles/<bundle>/<skill>.md) but no further", () => {
    const dir = join(root, "depth-cap");
    mkdirSync(dir, { recursive: true });
    writeSkillFile(join(dir, "level0.md"), "level0");
    writeSkillFile(join(dir, "child", "level1.md"), "level1");
    writeSkillFile(join(dir, "child", "grandchild", "level2.md"), "level2");
    writeSkillFile(
      join(dir, "child", "grandchild", "great-grandchild", "level3.md"),
      "level3",
    );

    const skills = loadScopedSkills(dir, "workspace");
    const names = skills.map((s) => s.manifest.name).sort();
    expect(names).toEqual(["level0", "level1", "level2"]);
  });
});

describe("loadScopedSkills — error tolerance", () => {
  test("returns [] when the directory does not exist", () => {
    const missing = join(root, "does-not-exist");
    expect(loadScopedSkills(missing, "workspace")).toEqual([]);
  });

  test("returns [] for an empty directory", () => {
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    expect(loadScopedSkills(empty, "user")).toEqual([]);
  });

  test("returns [] for a non-existent workspace id path", () => {
    const wsRoot = join(root, "workspaces", "ws_does_not_exist", "skills");
    expect(loadScopedSkills(wsRoot, "workspace")).toEqual([]);
  });
});

// ---- mergeScopedSkills (pure helper backing Runtime.loadConversationSkills) -----

function makeSkill(name: string, scope: "org" | "workspace" | "user", body = ""): Skill {
  return {
    manifest: {
      name,
      description: name,
      version: "1.0.0",
      type: "skill",
      priority: 50,
      scope,
      status: "active",
    },
    body,
    sourcePath: `/virtual/${scope}/${name}.md`,
  };
}

describe("mergeScopedSkills — precedence", () => {
  test("org-only skills appear with scope=org", () => {
    const merged = mergeScopedSkills(
      [makeSkill("only-org", "org")],
      [],
      [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.manifest.name).toBe("only-org");
    expect(merged[0]!.manifest.scope).toBe("org");
  });

  test("workspace overrides org on name collision", () => {
    const merged = mergeScopedSkills(
      [makeSkill("voice", "org", "org-body")],
      [makeSkill("voice", "workspace", "workspace-body")],
      [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.manifest.scope).toBe("workspace");
    expect(merged[0]!.body).toBe("workspace-body");
  });

  test("user overrides workspace (and org) on name collision", () => {
    const merged = mergeScopedSkills(
      [makeSkill("voice", "org", "org-body")],
      [makeSkill("voice", "workspace", "workspace-body")],
      [makeSkill("voice", "user", "user-body")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.manifest.scope).toBe("user");
    expect(merged[0]!.body).toBe("user-body");
  });

  test("non-colliding skills from all three layers all survive", () => {
    const merged = mergeScopedSkills(
      [makeSkill("p1", "org"), makeSkill("p2", "org")],
      [makeSkill("w1", "workspace")],
      [makeSkill("u1", "user")],
    );
    const names = merged.map((s) => s.manifest.name).sort();
    expect(names).toEqual(["p1", "p2", "u1", "w1"]);
  });

  test("user collision shadows org without affecting unrelated workspace skills", () => {
    const merged = mergeScopedSkills(
      [makeSkill("voice", "org"), makeSkill("identity", "org")],
      [makeSkill("kanban-rules", "workspace")],
      [makeSkill("voice", "user")],
    );
    const byName = new Map(merged.map((s) => [s.manifest.name, s]));
    expect(byName.get("voice")!.manifest.scope).toBe("user");
    expect(byName.get("identity")!.manifest.scope).toBe("org");
    expect(byName.get("kanban-rules")!.manifest.scope).toBe("workspace");
    expect(merged).toHaveLength(3);
  });

  test("empty inputs return []", () => {
    expect(mergeScopedSkills([], [], [])).toEqual([]);
  });
});

describe("loadScopedSkills + mergeScopedSkills — end-to-end on tmpdir", () => {
  test("workspace + user skills layered onto an org pool", () => {
    const orgDir = join(root, "skills");
    mkdirSync(orgDir, { recursive: true });
    writeSkillFile(join(orgDir, "voice.md"), "voice");
    writeSkillFile(join(orgDir, "identity.md"), "identity");

    const wsDir = join(root, "workspaces", "ws_test", "skills");
    mkdirSync(wsDir, { recursive: true });
    writeSkillFile(join(wsDir, "voice.md"), "voice"); // overrides org.voice
    writeSkillFile(join(wsDir, "kanban.md"), "kanban"); // workspace-only

    const userDir = join(root, "users", "user_test", "skills");
    mkdirSync(userDir, { recursive: true });
    writeSkillFile(join(userDir, "voice.md"), "voice"); // overrides workspace.voice
    writeSkillFile(join(userDir, "personal.md"), "personal"); // user-only

    const org = loadScopedSkills(orgDir, "org");
    const workspace = loadScopedSkills(wsDir, "workspace");
    const user = loadScopedSkills(userDir, "user");
    const merged = mergeScopedSkills(org, workspace, user);

    const byName = new Map(merged.map((s) => [s.manifest.name, s]));
    expect(byName.size).toBe(4);
    expect(byName.get("voice")!.manifest.scope).toBe("user");
    expect(byName.get("identity")!.manifest.scope).toBe("org");
    expect(byName.get("kanban")!.manifest.scope).toBe("workspace");
    expect(byName.get("personal")!.manifest.scope).toBe("user");
  });

  test("missing user dir at the conventional path is a no-op", () => {
    const orgDir = join(root, "skills");
    mkdirSync(orgDir, { recursive: true });
    writeSkillFile(join(orgDir, "voice.md"), "voice");

    const wsDir = join(root, "workspaces", "ws_test", "skills"); // not created
    const userDir = join(root, "users", "user_test", "skills"); // not created

    const org = loadScopedSkills(orgDir, "org");
    const workspace = loadScopedSkills(wsDir, "workspace");
    const user = loadScopedSkills(userDir, "user");
    const merged = mergeScopedSkills(org, workspace, user);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.manifest.name).toBe("voice");
    expect(merged[0]!.manifest.scope).toBe("org");
  });
});
