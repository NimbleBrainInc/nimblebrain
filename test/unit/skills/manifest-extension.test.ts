/**
 * Phase 2 — `SkillManifest` extension tests.
 *
 * The manifest gained six optional fields (scope, loadingStrategy,
 * appliesToTools, status, overrides, derivedFrom). These tests verify:
 *
 *   - Each new field parses from frontmatter (kebab-case + snake_case).
 *   - Defaults match the spec (loadingStrategy resolution; status="active").
 *   - Invalid values warn and fall through to the default.
 *   - The writer round-trips the new fields cleanly.
 *   - Existing core skills (no new fields) parse and re-serialize unchanged.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseSkillContent } from "../../../src/skills/loader.ts";
import type { Skill, SkillManifest } from "../../../src/skills/types.ts";
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

function parse(raw: string, path = "/virtual.md"): Skill {
  const skill = parseSkillContent(raw, path);
  if (!skill) throw new Error("parseSkillContent returned null");
  return skill;
}

describe("Phase 2 manifest fields — parsing", () => {
  test("parses scope, loading-strategy, applies-to-tools, status, derived-from", () => {
    const skill = parse(`---
name: cross-bundle
description: A cross-bundle workflow
version: 1.2.3
type: skill
priority: 25
scope: workspace
loading-strategy: tool_affined
applies-to-tools:
  - synapse-collateral__*
  - "*__patch_source"
status: draft
derived-from: skill://platform/voice-rules
---
Body.
`);
    expect(skill.manifest.scope).toBe("workspace");
    expect(skill.manifest.loadingStrategy).toBe("tool_affined");
    expect(skill.manifest.appliesToTools).toEqual([
      "synapse-collateral__*",
      "*__patch_source",
    ]);
    expect(skill.manifest.status).toBe("draft");
    expect(skill.manifest.derivedFrom).toBe("skill://platform/voice-rules");
  });

  test("snake_case keys are equivalent to kebab-case", () => {
    const skill = parse(`---
name: snakey
description: tests snake_case
version: 1.0.0
type: skill
priority: 50
loading_strategy: always
applies_to_tools:
  - foo__*
derived_from: skill://x/y
---
Body.
`);
    expect(skill.manifest.loadingStrategy).toBe("always");
    expect(skill.manifest.appliesToTools).toEqual(["foo__*"]);
    expect(skill.manifest.derivedFrom).toBe("skill://x/y");
  });

  test("overrides parse with bundle, skill, reason fields", () => {
    const skill = parse(`---
name: override-something
description: overrides a bundle skill
version: 1.0.0
type: skill
priority: 50
overrides:
  - bundle: synapse-collateral
    skill: patch-policy
    reason: Project requires manual review on every patch
  - reason: Tightening default tool-affinity
---
Body.
`);
    expect(skill.manifest.overrides).toEqual([
      {
        bundle: "synapse-collateral",
        skill: "patch-policy",
        reason: "Project requires manual review on every patch",
      },
      { reason: "Tightening default tool-affinity" },
    ]);
  });
});

describe("Phase 2 manifest fields — defaults", () => {
  test("loading-strategy defaults to tool_affined when applies-to-tools is set", () => {
    const skill = parse(`---
name: implicit-tool-affined
description: x
version: 1.0.0
type: skill
priority: 50
applies-to-tools:
  - foo__*
---
`);
    expect(skill.manifest.loadingStrategy).toBe("tool_affined");
  });

  test("loading-strategy defaults to always for type:context with no applies-to-tools", () => {
    const skill = parse(`---
name: context-always
description: x
version: 1.0.0
type: context
priority: 25
---
`);
    expect(skill.manifest.loadingStrategy).toBe("always");
  });

  test("loading-strategy is undefined for type:skill with no applies-to-tools", () => {
    const skill = parse(`---
name: classic-skill
description: x
version: 1.0.0
type: skill
priority: 50
metadata:
  keywords: [foo]
---
`);
    expect(skill.manifest.loadingStrategy).toBeUndefined();
  });

  test("status defaults to active when omitted", () => {
    const skill = parse(`---
name: defaults-status
description: x
version: 1.0.0
type: skill
priority: 50
---
`);
    expect(skill.manifest.status).toBe("active");
  });
});

describe("Phase 2 manifest fields — invalid values fall through", () => {
  test("invalid loading-strategy logs a warning and falls back to the default", () => {
    const skill = parse(`---
name: bogus-strategy
description: x
version: 1.0.0
type: context
priority: 25
loading-strategy: bogus
---
`);
    // type: context with no applies-to-tools → default = always
    expect(skill.manifest.loadingStrategy).toBe("always");
  });

  test("invalid status falls back to active", () => {
    const skill = parse(`---
name: bogus-status
description: x
version: 1.0.0
type: skill
priority: 50
status: weird
---
`);
    expect(skill.manifest.status).toBe("active");
  });

  test("invalid scope is ignored (left undefined for the multi-scope loader to stamp)", () => {
    const skill = parse(`---
name: bad-scope
description: x
version: 1.0.0
type: skill
priority: 50
scope: hodgepodge
---
`);
    expect(skill.manifest.scope).toBeUndefined();
  });
});

describe("Phase 2 manifest fields — round-trip", () => {
  test("write → read preserves the new fields", () => {
    const manifest: SkillManifest = {
      name: "round-trip",
      description: "roundtrip me",
      version: "2.0.0",
      type: "skill",
      priority: 33,
      scope: "user",
      loadingStrategy: "tool_affined",
      appliesToTools: ["synapse-collateral__*"],
      status: "draft",
      overrides: [{ bundle: "x", skill: "y", reason: "because" }],
      derivedFrom: "skill://platform/parent",
      metadata: {
        keywords: ["k1"],
        triggers: [],
        tags: ["t1"],
      },
    };
    writeSkill(tmpDir, "round-trip", manifest, "Body content here.");

    const read = readSkill(tmpDir, "round-trip");
    expect(read).not.toBeNull();
    expect(read?.manifest.scope).toBe("user");
    expect(read?.manifest.loadingStrategy).toBe("tool_affined");
    expect(read?.manifest.appliesToTools).toEqual(["synapse-collateral__*"]);
    expect(read?.manifest.status).toBe("draft");
    expect(read?.manifest.overrides).toEqual([
      { bundle: "x", skill: "y", reason: "because" },
    ]);
    expect(read?.manifest.derivedFrom).toBe("skill://platform/parent");
    expect(read?.body).toContain("Body content here.");
  });

  test("status:active is not written to disk (default-suppression keeps round-trips minimal)", () => {
    const manifest: SkillManifest = {
      name: "active-default",
      description: "the default status",
      version: "1.0.0",
      type: "skill",
      priority: 50,
      status: "active",
    };
    writeSkill(tmpDir, "active-default", manifest, "Body.");
    const raw = readFileSync(join(tmpDir, "active-default.md"), "utf-8");
    expect(raw).not.toMatch(/^status:/m);
    // Yet on read the default fills back in.
    expect(readSkill(tmpDir, "active-default")?.manifest.status).toBe("active");
  });

  test("manifest with no Phase 2 fields stays clean on round-trip", () => {
    const manifest: SkillManifest = {
      name: "vanilla",
      description: "no extras",
      version: "1.0.0",
      type: "skill",
      priority: 50,
    };
    writeSkill(tmpDir, "vanilla", manifest, "Body.");
    const raw = readFileSync(join(tmpDir, "vanilla.md"), "utf-8");
    expect(raw).not.toMatch(/scope:/);
    expect(raw).not.toMatch(/loading-strategy:/);
    expect(raw).not.toMatch(/applies-to-tools:/);
    expect(raw).not.toMatch(/overrides:/);
    expect(raw).not.toMatch(/derived-from:/);
  });
});

describe("Phase 2 manifest fields — existing core skills round-trip cleanly", () => {
  // The existing core skills don't use any Phase 2 fields. After round-trip
  // through write/read, every existing field must come back unchanged.
  const coreSkillNames = readdirSync(CORE_DIR).filter((f) => f.endsWith(".md"));

  for (const file of coreSkillNames) {
    test(`core skill ${file} survives round-trip`, () => {
      const path = join(CORE_DIR, file);
      const raw = readFileSync(path, "utf-8");
      const original = parse(raw, path);

      writeSkill(tmpDir, original.manifest.name, original.manifest, original.body);
      const reread = readSkill(tmpDir, original.manifest.name);
      expect(reread).not.toBeNull();
      const o = original.manifest;
      const r = reread!.manifest;

      expect(r.name).toBe(o.name);
      expect(r.description).toBe(o.description);
      expect(r.version).toBe(o.version);
      expect(r.type).toBe(o.type);
      expect(r.priority).toBe(o.priority);
      // status defaults to "active" both before and after
      expect(r.status).toBe("active");
      expect(reread!.body.trim()).toBe(original.body.trim());
    });
  }
});
