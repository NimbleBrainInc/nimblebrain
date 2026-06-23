/**
 * Vendored core skills round-trip cleanly through write → read — the writer
 * produces frontmatter the canonical-schema loader accepts, unchanged.
 *
 * (Frontmatter validation + the on-disk→runtime mapping are covered by
 * `test/unit/skills/skill-manifest.test.ts`; the old permissive-parser tests
 * this file used to hold were retired with that parser.)
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseSkillContent } from "../../../src/skills/loader.ts";
import { readSkill, writeSkill } from "../../../src/skills/writer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, "../../../src/skills/core");

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "skill-manifest-ext-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("vendored core skills round-trip cleanly", () => {
  const coreSkillNames = readdirSync(CORE_DIR).filter((f) => f.endsWith(".md"));

  for (const file of coreSkillNames) {
    test(`core skill ${file} survives write → read`, () => {
      const path = join(CORE_DIR, file);
      const original = parseSkillContent(readFileSync(path, "utf-8"), path);
      expect(original).not.toBeNull();
      const o = original!.manifest;

      writeSkill(tmpDir, o.name, o, original!.body);
      const reread = readSkill(tmpDir, o.name);
      expect(reread).not.toBeNull();
      const r = reread!.manifest;

      expect(r.name).toBe(o.name);
      expect(r.description).toBe(o.description);
      expect(r.loadingStrategy).toBe(o.loadingStrategy);
      expect(r.priority).toBe(o.priority);
      expect(r.status).toBe(o.status);
      expect(reread!.body.trim()).toBe(original!.body.trim());
    });
  }
});
