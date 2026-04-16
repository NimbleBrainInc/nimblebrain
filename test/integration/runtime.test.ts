import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import { filterTools } from "../../src/runtime/tools.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import type { EngineEvent, EventSink, ToolSchema } from "../../src/engine/types.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-runtime-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("filterTools", () => {
  const tools: ToolSchema[] = [
    { name: "leadgen__create_prospect", description: "", inputSchema: {} },
    { name: "leadgen__search_prospects", description: "", inputSchema: {} },
    { name: "hunter__find_email", description: "", inputSchema: {} },
    { name: "hunter__verify_email", description: "", inputSchema: {} },
    { name: "workspace__read_file", description: "", inputSchema: {} },
  ];

  it("returns all tools when patterns is empty", () => {
    expect(filterTools(tools, [])).toHaveLength(5);
  });

  it("filters by exact match", () => {
    const result = filterTools(tools, ["hunter__find_email"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("hunter__find_email");
  });

  it("filters by glob pattern", () => {
    const result = filterTools(tools, ["leadgen__*"]);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual([
      "leadgen__create_prospect",
      "leadgen__search_prospects",
    ]);
  });

  it("supports multiple patterns", () => {
    const result = filterTools(tools, ["leadgen__*", "hunter__find_email"]);
    expect(result).toHaveLength(3);
  });

  it("returns empty array when nothing matches", () => {
    const result = filterTools(tools, ["nonexistent__*"]);
    expect(result).toHaveLength(0);
  });
});

describe("Runtime", () => {
  it("starts with echo model and processes a chat", async () => {
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
    });
    await provisionTestWorkspace(runtime);

    const result = await runtime.chat({ message: "Hello there", workspaceId: TEST_WORKSPACE_ID });

    expect(result.response).toBe("Hello there");
    expect(result.conversationId).toMatch(/^conv_/);
    expect(result.skillName).toBeNull();
    expect(result.stopReason).toBe("complete");

    await runtime.shutdown();
  });

  it("maintains conversation continuity", async () => {
    const workDir = join(testDir, "continuity");
    mkdirSync(workDir, { recursive: true });
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const first = await runtime.chat({ message: "First message", workspaceId: TEST_WORKSPACE_ID });
    const second = await runtime.chat({
      message: "Second message",
      conversationId: first.conversationId,
      workspaceId: TEST_WORKSPACE_ID,
    });

    expect(second.conversationId).toBe(first.conversationId);

    await runtime.shutdown();
  });

  it("creates new conversation when no id provided", async () => {
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
    });
    await provisionTestWorkspace(runtime);

    const first = await runtime.chat({ message: "A", workspaceId: TEST_WORKSPACE_ID });
    const second = await runtime.chat({ message: "B", workspaceId: TEST_WORKSPACE_ID });

    expect(first.conversationId).not.toBe(second.conversationId);

    await runtime.shutdown();
  });

  it("uses JSONL store when configured", async () => {
    const workDir = join(testDir, "jsonl-store");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    await provisionTestWorkspace(runtime);

    await runtime.chat({ message: "Persistent", workspaceId: TEST_WORKSPACE_ID });

    // Conversations are stored in workspace-scoped paths
    const wsConvDir = join(workDir, "workspaces", TEST_WORKSPACE_ID, "conversations");
    const files = new Bun.Glob("**/*.jsonl").scanSync(wsConvDir);
    const fileList = [...files];
    expect(fileList.length).toBeGreaterThan(0);

    await runtime.shutdown();
  });

  it("loads skills and matches them", async () => {
    const skillDir = join(testDir, "skills");
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, "greeter.md"),
      `---
name: greeter
description: Greets people
version: 1.0.0
metadata:
  keywords: [hello, greet, hi, hey]
  triggers: ["say hello", "greet someone"]
---

You are a friendly greeter. Always respond with enthusiasm!
`,
    );

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });
    await provisionTestWorkspace(runtime);

    const result = await runtime.chat({ message: "say hello and greet everyone", workspaceId: TEST_WORKSPACE_ID });
    expect(result.skillName).toBe("greeter");

    await runtime.shutdown();
  });

  it("composes system prompt from context skills", async () => {
    // Create a context skill that provides identity
    const skillDir = join(testDir, "context-skills");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "identity.md"),
      `---
name: identity
description: Agent identity
version: 1.0.0
type: context
priority: 0
---

I am Nira, your AI assistant. You work at Acme Corp.
`,
    );

    let capturedSystem = "";
    const model = createMockModel((options) => {
      const systemMsg = options.prompt.find((m) => m.role === "system");
      if (systemMsg && typeof systemMsg.content === "string") {
        // Skip auto-title calls
        if (!systemMsg.content.includes("Generate a 3-6 word title")) {
          capturedSystem = systemMsg.content;
        }
      }
      return {
        content: [{ type: "text", text: "ok" }],
        inputTokens: 10,
        outputTokens: 5,
      };
    });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: model },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });
    await provisionTestWorkspace(runtime);

    await runtime.chat({ message: "Hello", workspaceId: TEST_WORKSPACE_ID });

    expect(capturedSystem).toContain("I am Nira");
    expect(capturedSystem).toContain("Acme Corp");

    await runtime.shutdown();
  });

  it("reloads skills dynamically", async () => {
    const skillDir = join(testDir, "dynamic-skills");
    mkdirSync(skillDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      skillDirs: [skillDir],
    });
    await provisionTestWorkspace(runtime);

    // No skills initially
    let result = await runtime.chat({ message: "say hello and greet everyone", workspaceId: TEST_WORKSPACE_ID });
    expect(result.skillName).toBeNull();

    // Add a skill
    writeFileSync(
      join(skillDir, "greeter.md"),
      `---
name: greeter
description: Greets
version: 1.0.0
metadata:
  keywords: [hello, greet, hi]
  triggers: ["say hello"]
---
Greet with enthusiasm!
`,
    );

    await runtime.reloadSkills();

    result = await runtime.chat({ message: "say hello and greet everyone", workspaceId: TEST_WORKSPACE_ID });
    expect(result.skillName).toBe("greeter");

    await runtime.shutdown();
  });

  it("forwards events to configured sinks", async () => {
    const events: string[] = [];
    const sink: EventSink = {
      emit(event: EngineEvent) {
        events.push(event.type);
      },
    };

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      events: [sink],
    });
    await provisionTestWorkspace(runtime);

    await runtime.chat({ message: "Hello", workspaceId: TEST_WORKSPACE_ID });

    expect(events).toContain("run.start");
    expect(events).toContain("run.done");

    await runtime.shutdown();
  });

  it("reports available tools (empty when no bundles)", async () => {
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
    });

    const tools = await runtime.availableTools();
    // System tools + nb-core tools are always present even without bundles.
    // Exact count may change as tools are added — verify minimum expected set.
    expect(tools.length).toBeGreaterThanOrEqual(15);
    const names = tools.map((t) => t.name).sort();
    // Verify system tools
    expect(names).toContain("nb__status");
    expect(names).toContain("nb__delegate");
    expect(names).toContain("nb__search");
    expect(names).toContain("nb__manage_app");
    // Verify core tools (including internal ones — availableTools returns all)
    expect(names).toContain("nb__set_model_config");

    await runtime.shutdown();
  });
});
