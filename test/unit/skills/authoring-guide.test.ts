/**
 * Layer 1 vendored authoring-guide content tests.
 *
 * Verifies the markdown file shipped at `src/skills/builtin/authoring-guide.md`
 * parses cleanly through the loader, carries the manifest fields the bundle
 * relies on, and keeps its top-level structure stable across edits.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import matter from "gray-matter";
import { parseSkillFile } from "../../../src/skills/loader.ts";
import { validateFrontmatter } from "../../../src/skills/schemas/skill-manifest.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = resolve(__dirname, "../../../src/skills/builtin/authoring-guide.md");

describe("authoring-guide Layer 1 skill", () => {
  test("file parses without errors via parseSkillFile", () => {
    const skill = parseSkillFile(GUIDE_PATH);
    expect(skill).not.toBeNull();
  });

  test("manifest carries the bundle-shipped Layer 1 fields", () => {
    const skill = parseSkillFile(GUIDE_PATH);
    if (!skill) throw new Error("parseSkillFile returned null");

    expect(skill.manifest.name).toBe("authoring-guide");
    // Capability skill: dynamic + tool-affinity (skills__*), routed to Layer 3.
    // (`scope` is stamped at load, not present when parsing the file directly.)
    expect(skill.manifest.loadingStrategy).toBe("dynamic");
    expect(skill.manifest.priority).toBe(25);
    expect(skill.manifest.toolAffinity).toBeDefined();
    expect(skill.manifest.toolAffinity).toContain("skills__*");
  });

  test("body is non-empty and exceeds the minimum operational size", () => {
    const skill = parseSkillFile(GUIDE_PATH);
    if (!skill) throw new Error("parseSkillFile returned null");
    expect(skill.body.length).toBeGreaterThan(1000);
  });

  test("anti-patterns and authoring-checklist sections are present", () => {
    const skill = parseSkillFile(GUIDE_PATH);
    if (!skill) throw new Error("parseSkillFile returned null");

    // Heading presence — match `## Anti-patterns` (any casing) on its own line.
    expect(skill.body).toMatch(/^##\s+anti-patterns/im);
    // Heading presence — match `## Authoring checklist` (any casing).
    expect(skill.body).toMatch(/^##\s+authoring checklist/im);
  });

  test("anti-patterns section contains at least 5 list items", () => {
    const skill = parseSkillFile(GUIDE_PATH);
    if (!skill) throw new Error("parseSkillFile returned null");

    const lines = skill.body.split("\n");
    const headingIdx = lines.findIndex((l) => /^##\s+anti-patterns/i.test(l));
    expect(headingIdx).toBeGreaterThanOrEqual(0);

    // Walk forward until the next `## ` heading; count `- ` list items.
    let bulletCount = 0;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) break;
      if (/^##\s+/.test(line)) break;
      if (/^- /.test(line)) bulletCount += 1;
    }
    expect(bulletCount).toBeGreaterThanOrEqual(5);
  });

  test("the worked frontmatter example actually validates against the canonical schema", () => {
    const skill = parseSkillFile(GUIDE_PATH);
    if (!skill) throw new Error("parseSkillFile returned null");
    // Extract the first ```yaml fenced block (the worked example) and validate it.
    const block = skill.body.match(/```yaml\n([\s\S]*?)```/);
    if (!block) throw new Error("no ```yaml example block found in the guide body");
    const example = matter(block[1] as string);
    const result = validateFrontmatter(example.data);
    if (!result.ok) {
      throw new Error(`worked example frontmatter is invalid: ${result.errors.join("; ")}`);
    }
    expect(result.ok).toBe(true);
  });
});

describe("vendored skill bodies use the current schema (no removed fields)", () => {
  // Guards the class of bug where a schema cutover migrates frontmatter + code
  // but leaves the agent-facing instructional BODY teaching the old shape.
  const SKILL_DIRS = [
    resolve(__dirname, "../../../src/skills/core"),
    resolve(__dirname, "../../../src/skills/builtin"),
  ];
  const LEGACY_TOKENS: Array<[string, RegExp]> = [
    ["type: skill|context", /\btype:\s*(skill|context)\b/],
    ["tool_affined", /tool_affined/],
    ["applies-to-tools", /applies[-_]to[-_]tools/],
    ["loading_strategy (snake_case)", /loading_strategy/],
    ["overrides block", /^\s*overrides:/m],
  ];
  for (const dir of SKILL_DIRS) {
    for (const file of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
      test(`${file} body names no removed schema fields`, () => {
        const body = matter(readFileSync(resolve(dir, file), "utf-8")).content;
        for (const [label, re] of LEGACY_TOKENS) {
          if (re.test(body)) {
            throw new Error(`${file} still references removed schema field: ${label}`);
          }
        }
      });
    }
  }
});
