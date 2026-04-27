/**
 * Layer 1 vendored authoring-guide content tests.
 *
 * Verifies the markdown file shipped at `src/skills/builtin/authoring-guide.md`
 * parses cleanly through the loader, carries the manifest fields the bundle
 * relies on, and keeps its top-level structure stable across edits.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { parseSkillFile } from "../../../src/skills/loader.ts";

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
    expect(skill.manifest.type).toBe("context");
    expect(skill.manifest.priority).toBe(25);
    expect(skill.manifest.scope).toBe("bundle");
    expect(skill.manifest.loadingStrategy).toBe("tool_affined");
    expect(skill.manifest.appliesToTools).toBeDefined();
    expect(skill.manifest.appliesToTools).toContain("skills__*");
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
});
