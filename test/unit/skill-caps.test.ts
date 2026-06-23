import { describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import matter from "gray-matter";
import { loadScopedSkills, parseSkillContent } from "../../src/skills/loader.ts";
import { MAX_SKILL_BODY_CHARS } from "../../src/skills/truncate.ts";
import { readSkill, updateSkill, writeSkill } from "../../src/skills/writer.ts";
import type { SkillManifest } from "../../src/skills/types.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "skill-caps-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function rawSkill(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: d\n---\n${body}`;
}

describe("per-skill body cap", () => {
  const bigManifest: SkillManifest = {
    name: "big",
    description: "d",
    loadingStrategy: "dynamic",
    priority: 50,
    status: "active",
  };

  it("returns the FULL body by default (read/inspect/round-trip safe)", () => {
    // The default is the path skills__read and writer.readSkill take — it must
    // NOT truncate, or an agent that reads-then-rewrites loses user content.
    const big = "x".repeat(MAX_SKILL_BODY_CHARS * 2);
    expect(parseSkillContent(rawSkill("big", big), "big.md")!.body.length).toBe(big.length);
    expect(parseSkillContent(rawSkill("big", big), "big.md", { cap: false })!.body.length).toBe(
      big.length,
    );
  });

  it("caps only when cap:true is requested", () => {
    const big = "x".repeat(MAX_SKILL_BODY_CHARS * 2);
    const skill = parseSkillContent(rawSkill("big", big), "big.md", { cap: true });
    expect(skill!.body.length).toBeLessThanOrEqual(MAX_SKILL_BODY_CHARS);
  });

  it("the prompt-load path (loadScopedSkills) caps the body", () => {
    const dir = tmp();
    const big = "x".repeat(MAX_SKILL_BODY_CHARS * 2);
    writeSkill(dir, "big", bigManifest, big);
    const [loaded] = loadScopedSkills(dir, "workspace");
    expect(loaded).toBeDefined();
    expect(loaded!.body.length).toBeLessThanOrEqual(MAX_SKILL_BODY_CHARS);
  });
});

describe("authoring round-trip preserves the full stored body", () => {
  const manifest: SkillManifest = {
    name: "big",
    description: "d",
    loadingStrategy: "dynamic",
    priority: 50,
    status: "active",
  };

  it("readSkill returns the full body even when over the prompt cap", () => {
    const dir = tmp();
    const body = "y".repeat(MAX_SKILL_BODY_CHARS * 2);
    writeSkill(dir, "big", manifest, body);
    const read = readSkill(dir, "big");
    expect(read!.body.length).toBe(body.length);
  });

  it("a frontmatter-only updateSkill does NOT truncate the stored body", () => {
    const dir = tmp();
    const body = "z".repeat(MAX_SKILL_BODY_CHARS * 2);
    writeSkill(dir, "big", manifest, body);
    // Edit only the description (no new body) — the body must survive intact.
    updateSkill(dir, "big", { description: "edited" });
    const onDisk = matter(readFileSync(join(dir, "big.md"), "utf-8")).content.trim();
    expect(onDisk.length).toBe(body.length);
  });
});
