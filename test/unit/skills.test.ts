import { describe, expect, it, beforeEach, afterAll, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSkillContent, loadSkillDir, loadBuiltinSkills, loadCoreSkills, partitionSkills } from "../../src/skills/loader.ts";
import { SkillMatcher } from "../../src/skills/matcher.ts";
import type { Skill } from "../../src/skills/types.ts";

const VALID_SKILL = `---
name: lead-finder
description: Find and qualify leads. Use for lead, prospect, pipeline, qualify.
allowed-tools: "leadgen__* hunter__find_email"
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 50
    triggers: ["find leads", "search prospects", "qualify lead"]
---

# Lead Finder

You are a lead qualification expert. When the user asks to find leads:

1. Search using available criteria
2. Score and qualify matches
3. Present results with confidence scores
`;

const MINIMAL_SKILL = `---
name: simple
description: A simple skill
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 50
---

Just say hello.
`;

describe("parseSkillContent", () => {
  it("parses a full SKILL.md", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skill = parseSkillContent(VALID_SKILL, "/test/lead-finder.md");

      expect(skill).not.toBeNull();
      expect(skill!.manifest.name).toBe("lead-finder");
      expect(skill!.manifest.description).toContain("Find and qualify leads");
      expect(skill!.manifest.loadingStrategy).toBe("dynamic");
      expect(skill!.manifest.priority).toBe(50);
      expect(skill!.manifest.allowedTools).toEqual(["leadgen__*", "hunter__find_email"]);
      expect(skill!.manifest.triggers).toEqual(["find leads", "search prospects", "qualify lead"]);
      expect(skill!.body).toContain("lead qualification expert");
      expect(skill!.sourcePath).toBe("/test/lead-finder.md");
    } finally {
      spy.mockRestore();
    }
  });

  it("parses a minimal SKILL.md", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skill = parseSkillContent(MINIMAL_SKILL, "/test/simple.md");
      expect(skill).not.toBeNull();
      expect(skill!.manifest.name).toBe("simple");
      expect(skill!.manifest.loadingStrategy).toBe("dynamic");
      expect(skill!.manifest.priority).toBe(50);
      expect(skill!.body).toBe("Just say hello.");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns null when name is missing", () => {
    const noName = `---
description: No name
type: skill
priority: 50
metadata:
  keywords: [test]
  triggers: []
---
Body text.
`;
    expect(parseSkillContent(noName, "/test")).toBeNull();
  });

  it("returns null for empty frontmatter name", () => {
    const emptyName = `---
name: ""
type: skill
priority: 50
metadata:
  keywords: []
  triggers: []
---
Body.
`;
    expect(parseSkillContent(emptyName, "/test")).toBeNull();
  });

  it("rejects legacy top-level fields (fail-soft skip until migrated)", () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const legacy = `---\nname: legacy\ndescription: x\ntype: skill\npriority: 50\n---\nBody.\n`;
      expect(parseSkillContent(legacy, "/test/legacy.md")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("partitionSkills", () => {
  // Test alias: legacy `context`/`skill` map to the new always/dynamic strategy.
  function makeSkill(name: string, type: "context" | "skill", priority: number): Skill {
    return {
      manifest: {
        name,
        description: "",
        loadingStrategy: type === "context" ? "always" : "dynamic",
        priority,
        status: "active",
      },
      body: `Body for ${name}`,
      sourcePath: `/test/${name}.md`,
    };
  }

  it("separates context and skill types", () => {
    const all = [
      makeSkill("soul", "context", 0),
      makeSkill("bootstrap", "context", 10),
      makeSkill("filesystem", "skill", 50),
    ];

    const result = partitionSkills(all);
    expect(result.context).toHaveLength(2);
    expect(result.skills).toHaveLength(1);
    expect(result.context.map((s) => s.manifest.name)).toEqual(["soul", "bootstrap"]);
    expect(result.skills[0]!.manifest.name).toBe("filesystem");
  });

  it("sorts context skills by priority (ascending)", () => {
    const all = [
      makeSkill("high", "context", 20),
      makeSkill("low", "context", 0),
      makeSkill("mid", "context", 10),
    ];

    const result = partitionSkills(all);
    expect(result.context.map((s) => s.manifest.name)).toEqual(["low", "mid", "high"]);
  });

  it("returns empty arrays when no skills", () => {
    const result = partitionSkills([]);
    expect(result.context).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});

describe("loadSkillDir", () => {
  const testDir = join(tmpdir(), `nimblebrain-skills-${Date.now()}`);

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("loads all .md files from a directory", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(join(testDir, "lead-finder.md"), VALID_SKILL);
      writeFileSync(join(testDir, "simple.md"), MINIMAL_SKILL);
      writeFileSync(join(testDir, "not-a-skill.txt"), "ignored");

      const skills = loadSkillDir(testDir);
      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.manifest.name).sort()).toEqual(["lead-finder", "simple"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns empty array for nonexistent directory", () => {
    const skills = loadSkillDir("/nonexistent/path");
    expect(skills).toHaveLength(0);
  });

  it("skips invalid skill files", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(join(testDir, "valid.md"), VALID_SKILL);
      writeFileSync(join(testDir, "invalid.md"), "no frontmatter here");

      const skills = loadSkillDir(testDir);
      expect(skills).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("SkillMatcher", () => {
  // Trigger-only matcher: `dynamic` skills, matched on top-level `triggers`.
  function makeSkill(overrides: Partial<Skill["manifest"]> & { name: string }): Skill {
    return {
      manifest: {
        description: "",
        loadingStrategy: "dynamic",
        priority: 50,
        status: "active",
        ...overrides,
      },
      body: "Test prompt",
      sourcePath: "/test",
    };
  }

  it("matches on trigger phrase (substring)", () => {
    const matcher = new SkillMatcher();
    matcher.load([makeSkill({ name: "lead-finder", triggers: ["find leads", "search prospects"] })]);

    expect(matcher.match("can you find leads for me?")?.skill.manifest.name).toBe("lead-finder");
    expect(matcher.match("search prospects in the pipeline")?.skill.manifest.name).toBe("lead-finder");
  });

  it("returns the trigger phrase that fired (for load telemetry)", () => {
    const matcher = new SkillMatcher();
    matcher.load([makeSkill({ name: "lead-finder", triggers: ["find leads", "search prospects"] })]);

    expect(matcher.match("please search prospects now")?.trigger).toBe("search prospects");
  });

  it("trigger match wins immediately (first hit)", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({ name: "skill-a", triggers: ["do thing A"] }),
      makeSkill({ name: "skill-b", triggers: ["other"] }),
    ]);

    expect(matcher.match("please do thing A now")?.skill.manifest.name).toBe("skill-a");
  });

  it("is case insensitive for triggers", () => {
    const matcher = new SkillMatcher();
    matcher.load([makeSkill({ name: "test", triggers: ["Find Leads"] })]);

    expect(matcher.match("FIND LEADS please")?.skill.manifest.name).toBe("test");
  });

  // --- Status filter (toggled Off must not reach the matched-skill channel) ---

  it("excludes disabled skills from trigger matching", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({ name: "disabled-rule", status: "disabled", triggers: ["find leads"] }),
      makeSkill({ name: "active-rule", status: "active", triggers: ["search prospects"] }),
    ]);

    // A disabled skill matched here would be injected straight into Layer-4,
    // bypassing the Off toggle — its trigger must not match.
    expect(matcher.match("find leads for me")).toBeNull();
    expect(matcher.match("search prospects now")?.skill.manifest.name).toBe("active-rule");
  });

  // --- Role filtering (always skills compose into the context channel) ---

  it("excludes always (context) skills from matching", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      {
        manifest: {
          name: "soul",
          description: "Identity",
          loadingStrategy: "always",
          priority: 0,
          status: "active",
          triggers: ["soul"],
        },
        body: "Identity body",
        sourcePath: "/test",
      },
      makeSkill({ name: "lead-finder", triggers: ["find leads"] }),
    ]);

    // An always skill is never matchable, even with a trigger.
    expect(matcher.match("tell me about your soul")?.skill.manifest.name).not.toBe("soul");
    expect(matcher.match("find leads for me")?.skill.manifest.name).toBe("lead-finder");
  });

  // --- Edge cases ---

  it("returns null when no skill matches", () => {
    const matcher = new SkillMatcher();
    matcher.load([makeSkill({ name: "lead-finder", triggers: ["find leads"] })]);

    expect(matcher.match("what's the weather?")).toBeNull();
  });

  it("returns null with no skills loaded", () => {
    const matcher = new SkillMatcher();
    expect(matcher.match("anything")).toBeNull();
  });

  it("returns null for a dynamic skill with no triggers (catalog-only)", () => {
    const matcher = new SkillMatcher();
    matcher.load([makeSkill({ name: "catalog-only" })]);
    expect(matcher.match("anything at all")).toBeNull();
  });
});

describe("loadBuiltinSkills", () => {
  it("loads vendored built-in skills (e.g., authoring-guide)", () => {
    const skills = loadBuiltinSkills();
    const names = skills.map((s) => s.manifest.name).sort();
    expect(names).toContain("authoring-guide");
  });

  it("stamps provenance.origin = vendored on every builtin skill", () => {
    for (const s of loadBuiltinSkills()) {
      expect(s.manifest.provenance?.origin).toBe("vendored");
    }
  });
});

describe("loadCoreSkills", () => {
  it("loads core skills including soul", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skills = loadCoreSkills();
      const names = skills.map((s) => s.manifest.name).sort();

      expect(names).toEqual(["automation-authoring", "capabilities", "soul"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("capabilities is always-on (context channel)", () => {
    const skills = loadCoreSkills();
    const bs = skills.find((s) => s.manifest.name === "capabilities")!;
    expect(bs.manifest.loadingStrategy).toBe("always");
    expect(bs.manifest.priority).toBe(10);
    expect(bs.body).toContain("nb__search");
    expect(bs.body).toContain("nb__manage_tools");
  });

  it("soul is always-on with priority 0", () => {
    const skills = loadCoreSkills();
    const soul = skills.find((s) => s.manifest.name === "soul")!;
    expect(soul.manifest.loadingStrategy).toBe("always");
    expect(soul.manifest.priority).toBe(0);
    expect(soul.body).toContain("NimbleBrain");
  });

  it("stamps provenance.origin = vendored on core skills (the ledger excludes them by it)", () => {
    for (const s of loadCoreSkills()) {
      expect(s.manifest.provenance?.origin).toBe("vendored");
    }
  });

  it("no filesystem skill (bash is opt-in)", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skills = loadCoreSkills();
      const fs = skills.find((s) => s.manifest.name === "filesystem");
      expect(fs).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
