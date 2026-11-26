import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSchema } from "../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { Skill } from "../../src/skills/types.ts";
import { surfaceTools } from "../../src/tools/surfacing.ts";
import { ownerConversationsDir } from "../helpers/conversation-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-chat-ext-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// --- Helpers ---

function makeTool(name: string): ToolSchema {
  return { name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } };
}

function makeSystemTools(): ToolSchema[] {
  return ["nb__search", "nb__use_skill", "nb__status", "nb__manage_tools"].map(makeTool);
}

function makeSkill(opts: { allowedTools?: string[] } = {}): Skill {
  return {
    manifest: {
      loadingStrategy: "dynamic",
      status: "active",
      name: "test-skill",
      description: "Test",
      version: "1.0.0",
      priority: 50,
      allowedTools: opts.allowedTools,
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

  it("empty allowedTools array blocks all connector tools, only nb__* remain", () => {
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

/** The header the conversations plugin stored for a conversation (line 1 of its file). */
function storedHeader(workDir: string, conversationId: string): Record<string, unknown> {
  const convDir = ownerConversationsDir(workDir, TEST_WORKSPACE_ID, "usr_default");
  const content = readFileSync(join(convDir, `${conversationId}.jsonl`), "utf-8");
  return JSON.parse(content.split("\n")[0]!) as Record<string, unknown>;
}

describe("ChatRequest.metadata — conversation persistence", () => {
  it("metadata is stored with the conversation at create", async () => {
    const workDir = join(testDir, `meta-${Date.now()}`);
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
    });

    try {
      await provisionTestWorkspace(runtime);

      const result = await runtime.chat({
        identity: DEV_IDENTITY,
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        metadata: { source: "task", id: "test-123" },
      });

      // The contract's `create` carries it; the plugin stores it in the
      // conversation's header (dev owner `usr_default`, in TEST_WORKSPACE_ID).
      expect(storedHeader(workDir, result.conversationId).metadata).toEqual({
        source: "task",
        id: "test-123",
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("chat without metadata — no metadata field in conversation", async () => {
    const workDir = join(testDir, `nometa-${Date.now()}`);
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
    });

    try {
      await provisionTestWorkspace(runtime);

      const result = await runtime.chat({
        identity: DEV_IDENTITY,
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
      });
      expect(storedHeader(workDir, result.conversationId).metadata).toBeUndefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("metadata is only set on new conversations, not overwritten on existing", async () => {
    const workDir = join(testDir, `metakeep-${Date.now()}`);
    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
    });

    try {
      await provisionTestWorkspace(runtime);

      // First message sets metadata
      const result1 = await runtime.chat({
        identity: DEV_IDENTITY,
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        metadata: { source: "first" },
      });

      // Second message with different metadata on same conversation — original metadata kept
      await runtime.chat({
        identity: DEV_IDENTITY,
        message: "world",
        conversationId: result1.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
        metadata: { source: "second" },
      });

      expect(storedHeader(workDir, result1.conversationId).metadata).toEqual({ source: "first" });
    } finally {
      await runtime.shutdown();
    }
  });
});
