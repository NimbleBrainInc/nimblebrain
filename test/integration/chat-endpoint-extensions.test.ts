import { describe, expect, it, afterAll } from "bun:test";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { surfaceTools } from "../../src/runtime/tools.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";
import type { ToolSchema } from "../../src/engine/types.ts";
import type { Skill } from "../../src/skills/types.ts";

const testDir = join(tmpdir(), `nimblebrain-chat-ext-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// --- Helpers ---

function makeTool(name: string): ToolSchema {
  return { name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } };
}

function makeSystemTools(): ToolSchema[] {
  return ["nb__search", "nb__manage_app", "nb__status", "nb__set_preferences"].map(makeTool);
}

function makeSkill(opts: { allowedTools?: string[] } = {}): Skill {
  return {
    manifest: {
      name: "test-skill",
      description: "Test",
      version: "1.0.0",
      type: "skill",
      priority: 50,
      allowedTools: opts.allowedTools,
      metadata: { keywords: ["test"], triggers: [] },
    },
    body: "You are a test expert.",
    sourcePath: "/test/skill.md",
  };
}

// --- surfaceTools with requestAllowedTools ---

describe("surfaceTools — requestAllowedTools", () => {
  it("filters to only matching tools + nb__* when requestAllowedTools is provided", () => {
    const system = makeSystemTools();
    const files = Array.from({ length: 5 }, (_, i) => makeTool(`files__tool_${i}`));
    const reports = Array.from({ length: 5 }, (_, i) => makeTool(`reports__tool_${i}`));
    const all = [...system, ...files, ...reports];

    const result = surfaceTools(all, null, {
      requestAllowedTools: ["files__*"],
    });

    // All 4 system tools + 5 files tools = 9 (under maxDirectTools, so Tier 1)
    expect(result.direct).toHaveLength(9);
    expect(result.proxied).toHaveLength(0);

    const names = result.direct.map((t) => t.name);
    for (const t of files) {
      expect(names).toContain(t.name);
    }
    for (const t of system) {
      expect(names).toContain(t.name);
    }
    // reports should be filtered out entirely
    for (const t of reports) {
      expect(names).not.toContain(t.name);
    }
  });

  it("empty allowedTools array blocks all bundle tools, only nb__* remain", () => {
    const system = makeSystemTools();
    const files = Array.from({ length: 5 }, (_, i) => makeTool(`files__tool_${i}`));
    const all = [...system, ...files];

    const result = surfaceTools(all, null, {
      requestAllowedTools: [],
    });

    // Only system tools survive
    expect(result.direct).toHaveLength(4);
    expect(result.proxied).toHaveLength(0);

    for (const t of result.direct) {
      expect(t.name.startsWith("nb__")).toBe(true);
    }
  });

  it("glob matching: multiple patterns match correctly", () => {
    const system = makeSystemTools();
    const reports = [makeTool("reports__list"), makeTool("reports__create")];
    const typst = [makeTool("typst__render"), makeTool("typst__compile")];
    const todo = [makeTool("todo__create"), makeTool("todo__list")];
    const all = [...system, ...reports, ...typst, ...todo];

    const result = surfaceTools(all, null, {
      requestAllowedTools: ["reports__*", "typst__render"],
    });

    const names = result.direct.map((t) => t.name);
    // reports__list and reports__create should match
    expect(names).toContain("reports__list");
    expect(names).toContain("reports__create");
    // typst__render should match (exact)
    expect(names).toContain("typst__render");
    // typst__compile should NOT match (only typst__render was listed, not typst__*)
    expect(names).not.toContain("typst__compile");
    // todo tools should NOT match
    expect(names).not.toContain("todo__create");
    expect(names).not.toContain("todo__list");
  });

  it("without requestAllowedTools: behavior identical to current", () => {
    const system = makeSystemTools();
    const app = Array.from({ length: 6 }, (_, i) => makeTool(`tasks__tool_${i}`));
    const all = [...system, ...app];

    const withoutFlag = surfaceTools(all, null);
    const withUndefined = surfaceTools(all, null, {});

    // Tier 1: all tools direct (10 total < 30 default max)
    expect(withoutFlag.direct).toHaveLength(10);
    expect(withoutFlag.proxied).toHaveLength(0);
    expect(withUndefined.direct).toHaveLength(10);
    expect(withUndefined.proxied).toHaveLength(0);
  });

  it("requestAllowedTools combines with skill allowedTools", () => {
    const system = makeSystemTools();
    const files = Array.from({ length: 10 }, (_, i) => makeTool(`files__tool_${i}`));
    const reports = Array.from({ length: 10 }, (_, i) => makeTool(`reports__tool_${i}`));
    const crm = Array.from({ length: 10 }, (_, i) => makeTool(`crm__tool_${i}`));
    const all = [...system, ...files, ...reports, ...crm];

    // Request allows files and reports; skill further restricts to files only
    const skill = makeSkill({ allowedTools: ["files__*"] });

    const result = surfaceTools(all, skill, {
      requestAllowedTools: ["files__*", "reports__*"],
    });

    // Pre-filter by request: system(4) + files(10) + reports(10) = 24 visible
    // Then Tier 3 (skill with allowedTools): files(10) + system(4) = 14 direct
    expect(result.direct).toHaveLength(14);
    // reports(10) are proxied (visible after request filter but not in skill globs)
    expect(result.proxied).toHaveLength(10);
  });
});

// --- Integration: metadata persisted in conversation ---

describe("ChatRequest.metadata — conversation persistence", () => {
  it("metadata is persisted in conversation object", async () => {
    const workDir = join(testDir, `meta-${Date.now()}`);
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    try {
      await provisionTestWorkspace(runtime);

      const result = await runtime.chat({
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        metadata: { source: "automation", id: "test-123" },
      });

      // Load the conversation and verify metadata is present
      const conv = await runtime.getStore(TEST_WORKSPACE_ID).load(result.conversationId);
      expect(conv).not.toBeNull();
      expect(conv!.metadata).toEqual({ source: "automation", id: "test-123" });

      // Verify it's actually in the JSONL file's first line
      const convDir = join(workDir, "workspaces", TEST_WORKSPACE_ID, "conversations");
      const files = require("fs").readdirSync(convDir).filter((f: string) => f.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(0);
      const content = readFileSync(join(convDir, files[0]!), "utf-8");
      const firstLine = JSON.parse(content.split("\n")[0]!);
      expect(firstLine.metadata).toEqual({ source: "automation", id: "test-123" });
    } finally {
      await runtime.shutdown();
    }
  });

  it("chat without metadata — no metadata field in conversation", async () => {
    const workDir = join(testDir, `nometa-${Date.now()}`);
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    try {
      await provisionTestWorkspace(runtime);

      const result = await runtime.chat({
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
      });
      const conv = await runtime.getStore(TEST_WORKSPACE_ID).load(result.conversationId);
      expect(conv).not.toBeNull();
      expect(conv!.metadata).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("metadata is only set on new conversations, not overwritten on existing", async () => {
    const workDir = join(testDir, `metakeep-${Date.now()}`);
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    try {
      await provisionTestWorkspace(runtime);

      // First message sets metadata
      const result1 = await runtime.chat({
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        metadata: { source: "first" },
      });

      // Second message with different metadata on same conversation — original metadata kept
      await runtime.chat({
        message: "world",
        conversationId: result1.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
        metadata: { source: "second" },
      });

      const conv = await runtime.getStore(TEST_WORKSPACE_ID).load(result1.conversationId);
      expect(conv!.metadata).toEqual({ source: "first" });
    } finally {
      await runtime.shutdown();
    }
  });
});
