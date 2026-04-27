import { describe, expect, it, beforeEach, afterAll, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSkillContent, loadSkillDir, loadBuiltinSkills, loadCoreSkills, partitionSkills } from "../../src/skills/loader.ts";
import { SkillMatcher } from "../../src/skills/matcher.ts";
import type { Skill } from "../../src/skills/types.ts";

const VALID_SKILL = `---
name: lead-finder
description: Find and qualify leads
version: 1.0.0
type: skill
priority: 50
allowed-tools:
  - "leadgen__*"
  - "hunter__find_email"
metadata:
  keywords: [lead, prospect, pipeline, qualify]
  triggers: ["find leads", "search prospects", "qualify lead"]
  category: sales
  tags: [crm, outreach]
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
version: 0.1.0
type: skill
priority: 50
metadata:
  keywords: [hello]
  triggers: []
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
      expect(skill!.manifest.description).toBe("Find and qualify leads");
      expect(skill!.manifest.version).toBe("1.0.0");
      expect(skill!.manifest.type).toBe("skill");
      expect(skill!.manifest.priority).toBe(50);
      expect(skill!.manifest.allowedTools).toEqual(["leadgen__*", "hunter__find_email"]);
      expect(skill!.manifest.metadata!.keywords).toEqual(["lead", "prospect", "pipeline", "qualify"]);
      expect(skill!.manifest.metadata!.triggers).toEqual(["find leads", "search prospects", "qualify lead"]);
      expect(skill!.manifest.metadata!.category).toBe("sales");
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
      expect(skill!.manifest.type).toBe("skill");
      expect(skill!.manifest.priority).toBe(50);
      expect(skill!.manifest.allowedTools).toEqual([]);
      expect(skill!.manifest.metadata!.triggers).toEqual([]);
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

  it("defaults type to 'skill' with warning when missing", () => {
    const noType = `---
name: no-type
description: No type field
version: 1.0.0
priority: 50
metadata:
  keywords: [test]
  triggers: []
---
Body.
`;
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skill = parseSkillContent(noType, "/test/no-type.md");
      expect(skill).not.toBeNull();
      expect(skill!.manifest.type).toBe("skill");
      const warnings = spy.mock.calls.map((c) => c[0] as string);
      expect(warnings.some((w) => w.includes("missing type"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("defaults priority to 50 with warning when missing", () => {
    const noPriority = `---
name: no-priority
description: No priority field
version: 1.0.0
type: skill
metadata:
  keywords: [test]
  triggers: []
---
Body.
`;
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skill = parseSkillContent(noPriority, "/test/no-priority.md");
      expect(skill).not.toBeNull();
      expect(skill!.manifest.priority).toBe(50);
      const warnings = spy.mock.calls.map((c) => c[0] as string);
      expect(warnings.some((w) => w.includes("missing priority"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("parses requires-bundles into requiresBundles", () => {
    const withBundles = `---
name: policy-skill
description: Policy lookup
version: 1.0.0
type: skill
priority: 50
requires-bundles:
  - "@acme/policy-search"
  - "@acme/compliance"
metadata:
  keywords: [policy]
  triggers: []
---
Look up policies.
`;
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skill = parseSkillContent(withBundles, "/test/policy.md");
      expect(skill).not.toBeNull();
      expect(skill!.manifest.requiresBundles).toEqual(["@acme/policy-search", "@acme/compliance"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns requiresBundles undefined when not present", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skill = parseSkillContent(VALID_SKILL, "/test/lead-finder.md");
      expect(skill).not.toBeNull();
      expect(skill!.manifest.requiresBundles).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("parses metadata.created_at and metadata.source", () => {
    const withExtMeta = `---
name: custom-skill
description: Custom skill
version: 1.0.0
type: skill
priority: 50
metadata:
  keywords: [custom]
  triggers: []
  created_at: "2026-03-24T22:00:00Z"
  source: user
---
Custom body.
`;
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skill = parseSkillContent(withExtMeta, "/test/custom.md");
      expect(skill).not.toBeNull();
      expect(skill!.manifest.metadata!.created_at).toBe("2026-03-24T22:00:00Z");
      expect(skill!.manifest.metadata!.source).toBe("user");
    } finally {
      spy.mockRestore();
    }
  });

  it("sets metadata to undefined when not present", () => {
    const noMeta = `---
name: no-meta
description: No metadata
version: 1.0.0
type: context
priority: 0
---
Body.
`;
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skill = parseSkillContent(noMeta, "/test/no-meta.md");
      expect(skill).not.toBeNull();
      expect(skill!.manifest.metadata).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("partitionSkills", () => {
  function makeSkill(name: string, type: "context" | "skill", priority: number): Skill {
    return {
      manifest: { name, description: "", version: "1.0.0", type, priority },
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
  function makeSkill(overrides: Partial<Skill["manifest"]> & { name: string }): Skill {
    return {
      manifest: {
        description: "",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        metadata: { keywords: [], triggers: [] },
        ...overrides,
      },
      body: "Test prompt",
      sourcePath: "/test",
    };
  }

  // --- Phase 1: Trigger matching ---

  it("matches on trigger phrase (substring)", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "lead-finder",
        metadata: { keywords: [], triggers: ["find leads", "search prospects"] },
      }),
    ]);

    expect(matcher.match("can you find leads for me?")?.manifest.name).toBe("lead-finder");
    expect(matcher.match("search prospects in the pipeline")?.manifest.name).toBe("lead-finder");
  });

  it("trigger match wins immediately (first hit)", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "skill-a",
        metadata: { keywords: [], triggers: ["do thing A"] },
      }),
      makeSkill({
        name: "skill-b",
        metadata: { keywords: ["thing", "stuff", "more"], triggers: [] },
      }),
    ]);

    expect(matcher.match("please do thing A now")?.manifest.name).toBe("skill-a");
  });

  it("is case insensitive for triggers", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "test",
        metadata: { keywords: [], triggers: ["Find Leads"] },
      }),
    ]);

    expect(matcher.match("FIND LEADS please")?.manifest.name).toBe("test");
  });

  // --- Phase 2: Keyword matching ---

  it("matches on keywords (requires >= 2 hits)", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "lead-finder",
        metadata: { keywords: ["lead", "prospect", "pipeline"], triggers: [] },
      }),
    ]);

    expect(matcher.match("find a lead and prospect")?.manifest.name).toBe("lead-finder");
  });

  it("does not match on single keyword hit", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "lead-finder",
        metadata: { keywords: ["lead", "prospect"], triggers: [] },
      }),
    ]);

    expect(matcher.match("find a lead")).toBeNull();
  });

  it("picks skill with most keyword hits", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "weak",
        metadata: { keywords: ["a", "b"], triggers: [] },
      }),
      makeSkill({
        name: "strong",
        metadata: { keywords: ["a", "b", "c"], triggers: [] },
      }),
    ]);

    expect(matcher.match("a b c d")?.manifest.name).toBe("strong");
  });

  it("works with many keywords (no ratio penalty)", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "broad-skill",
        metadata: {
          keywords: ["install", "server", "tool", "bundle", "skill", "connect", "search", "mpak"],
          triggers: [],
        },
      }),
    ]);

    expect(matcher.match("install a tool for me")?.manifest.name).toBe("broad-skill");
  });

  it("is case insensitive for keywords", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "test",
        metadata: { keywords: ["Lead", "Prospect"], triggers: [] },
      }),
    ]);

    expect(matcher.match("find a LEAD and PROSPECT")?.manifest.name).toBe("test");
  });

  // --- Context skill filtering ---

  it("excludes context skills from matching", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      {
        manifest: {
          name: "soul",
          description: "Identity",
          version: "1.0.0",
          type: "context",
          priority: 0,
        },
        body: "Identity body",
        sourcePath: "/test",
      },
      makeSkill({
        name: "lead-finder",
        metadata: { keywords: ["lead", "prospect"], triggers: ["find leads"] },
      }),
    ]);

    // Context skill should not be matched
    expect(matcher.match("tell me about your soul identity")?.manifest.name).not.toBe("soul");
    // Regular skill still matches
    expect(matcher.match("find leads for me")?.manifest.name).toBe("lead-finder");
  });

  // --- Edge cases ---

  it("returns null when no skill matches", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "lead-finder",
        metadata: { keywords: ["lead"], triggers: ["find leads"] },
      }),
    ]);

    expect(matcher.match("what's the weather?")).toBeNull();
  });

  it("returns null with no skills loaded", () => {
    const matcher = new SkillMatcher();
    expect(matcher.match("anything")).toBeNull();
  });

  it("trigger takes priority over keyword match on different skill", () => {
    const matcher = new SkillMatcher();
    matcher.load([
      makeSkill({
        name: "trigger-skill",
        metadata: { keywords: [], triggers: ["help me"] },
      }),
      makeSkill({
        name: "keyword-skill",
        metadata: { keywords: ["help", "assist", "support"], triggers: [] },
      }),
    ]);

    expect(matcher.match("help me with support")?.manifest.name).toBe("trigger-skill");
  });
});

describe("loadBuiltinSkills", () => {
  it("loads vendored built-in skills (e.g., authoring-guide)", () => {
    const skills = loadBuiltinSkills();
    const names = skills.map((s) => s.manifest.name).sort();
    expect(names).toContain("authoring-guide");
  });
});

describe("loadCoreSkills", () => {
  it("loads core skills including soul", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skills = loadCoreSkills();
      const names = skills.map((s) => s.manifest.name).sort();

      expect(names).toEqual(["automation-authoring", "capabilities", "skill-authoring", "soul"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("capabilities has type context", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skills = loadCoreSkills();
      const bs = skills.find((s) => s.manifest.name === "capabilities")!;

      expect(bs.manifest.type).toBe("context");
      expect(bs.manifest.priority).toBe(10);
      expect(bs.manifest.metadata!.keywords).toContain("install");
      expect(bs.manifest.metadata!.keywords).toContain("mpak");
      expect(bs.manifest.metadata!.triggers).toContain("what can you do");
      expect(bs.body).toContain("nb__search");
      expect(bs.body).toContain("nb__manage_app");
    } finally {
      spy.mockRestore();
    }
  });

  it("soul has type context with priority 0", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const skills = loadCoreSkills();
      const soul = skills.find((s) => s.manifest.name === "soul")!;

      expect(soul.manifest.type).toBe("context");
      expect(soul.manifest.priority).toBe(0);
      expect(soul.body).toContain("NimbleBrain");
    } finally {
      spy.mockRestore();
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
