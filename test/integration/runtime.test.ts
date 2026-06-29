import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceConversationsDir } from "../../src/conversation/paths.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { filterTools } from "../../src/tools/surfacing.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
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
      workDir: testDir,
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

  it("refuses to start without an explicit workDir under bun test (leak guard)", async () => {
    // NODE_ENV=test is set automatically by the bun runner. Without this guard a
    // missing workDir would default to ~/.nimblebrain and silently pollute the
    // developer's real conversations/workspaces. Assert the throw so a future
    // refactor can't quietly remove the protection.
    await expect(
      Runtime.start({
        model: { provider: "custom", adapter: createEchoModel() },
        noDefaultBundles: true,
      }),
    ).rejects.toThrow(/workDir/);
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
      workDir: testDir,
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
    });
    await provisionTestWorkspace(runtime);

    const first = await runtime.chat({ message: "A", workspaceId: TEST_WORKSPACE_ID });
    const second = await runtime.chat({ message: "B", workspaceId: TEST_WORKSPACE_ID });

    expect(first.conversationId).not.toBe(second.conversationId);

    await runtime.shutdown();
  });

  it("workspaceConversationStore() creates and uses the workspace's owner partition", async () => {
    const workDir = join(testDir, "user-conv-store-fresh-dir");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const wsId = personalWorkspaceIdFor("user_alice");
    const store = runtime.workspaceConversationStore(wsId, "user_alice");
    const conv = await store.create({ ownerId: "user_alice" });

    // The conversation lives under the workspace's owner partition:
    // {workDir}/workspaces/<wsId>/conversations/user_alice/{convId}.jsonl
    const ownerDir = workspaceConversationsDir(workDir, wsId, "user_alice");
    expect(existsSync(ownerDir)).toBe(true);
    expect(existsSync(join(ownerDir, `${conv.id}.jsonl`))).toBe(true);
    // Not at the old flat top-level path.
    expect(existsSync(join(workDir, "conversations", `${conv.id}.jsonl`))).toBe(false);

    // The conversation's owner round-trips.
    const loaded = await store.load(conv.id);
    expect(loaded?.ownerId).toBe("user_alice");

    await runtime.shutdown();
  });

  it("chat persists conversations under the workspace store", async () => {
    const workDir = join(testDir, "jsonl-store");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    await provisionTestWorkspace(runtime);

    // Dev-mode owner is `usr_default`; the chat is focused on TEST_WORKSPACE_ID,
    // so the conversation is born in that workspace's owner partition.
    await runtime.chat({ message: "Persistent", workspaceId: TEST_WORKSPACE_ID });

    const ownerDir = workspaceConversationsDir(workDir, TEST_WORKSPACE_ID, "usr_default");
    const workspaceFiles = [...new Bun.Glob("*.jsonl").scanSync(ownerDir)];
    expect(workspaceFiles.length).toBeGreaterThan(0);
    // Nothing was written at the old flat top-level path.
    expect(existsSync(join(workDir, "conversations"))).toBe(false);

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
metadata:
  nimblebrain:
    loading-strategy: dynamic
    triggers: ["say hello", "greet someone"]
---

You are a friendly greeter. Always respond with enthusiasm!
`,
    );

    const runtime = await Runtime.start({
      workDir: testDir,
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
metadata:
  nimblebrain:
    loading-strategy: always
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
      workDir: testDir,
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
    // Isolated workDir — earlier tests in this file write to `testDir/skills`
    // (the global skill dir), which would otherwise pre-load `greeter` here
    // and break the "No skills initially" assertion below.
    const isolatedWorkDir = join(testDir, `reload-skills-${Date.now()}`);
    mkdirSync(isolatedWorkDir, { recursive: true });
    const skillDir = join(isolatedWorkDir, "dynamic-skills");
    mkdirSync(skillDir, { recursive: true });

    const runtime = await Runtime.start({
      workDir: isolatedWorkDir,
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
metadata:
  nimblebrain:
    loading-strategy: dynamic
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
      workDir: testDir,
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
      workDir: testDir,
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
    expect(names).not.toContain("nb__manage_app");
    // Verify core tools (including internal ones — availableTools returns all)
    expect(names).toContain("nb__set_model_config");

    await runtime.shutdown();
  });
});
