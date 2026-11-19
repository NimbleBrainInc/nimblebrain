import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSkillOffs,
  setSkillOnIn,
  skillsOffIn,
} from "../../../src/identity/skills-off-store.ts";

const USER = "usr_concurrent";

describe("skills-off store, overlapping writes", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-skills-off-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("keeps both changes when two workspaces are set at once", async () => {
    await Promise.all([
      setSkillOnIn(workDir, USER, "ws_a", "one", false),
      setSkillOnIn(workDir, USER, "ws_b", "two", false),
    ]);
    expect([...skillsOffIn(workDir, USER, "ws_a")]).toEqual(["one"]);
    expect([...skillsOffIn(workDir, USER, "ws_b")]).toEqual(["two"]);
  });

  it("keeps a set that overlaps a clear of another skill", async () => {
    await setSkillOnIn(workDir, USER, "ws_a", "gone", false);
    await Promise.all([
      clearSkillOffs(workDir, USER, "gone"),
      setSkillOnIn(workDir, USER, "ws_b", "kept", false),
    ]);
    expect(skillsOffIn(workDir, USER, "ws_a").size).toBe(0);
    expect([...skillsOffIn(workDir, USER, "ws_b")]).toEqual(["kept"]);
  });
});
