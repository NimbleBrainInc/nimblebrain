/**
 * Smoke Test Suite for NimbleBrain Platform
 *
 * End-to-end integration tests using the @nimblebraininc/echo bundle from the mpak registry.
 * Validates the full path: mpak pull -> manifest parsing -> MCPB validation -> subprocess spawn ->
 * PYTHONPATH setup -> MCP handshake -> tool discovery -> tool execution.
 *
 * Uses an isolated temp directory (workDir) so nothing touches ~/.nimblebrain.
 */

import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { validateManifest } from "../../src/bundles/manifest.ts";
import { JsonlConversationStore } from "../../src/conversation/jsonl-store.ts";
import type { EngineEvent, EventSink, ToolResult } from "../../src/engine/types.ts";

/** Extract text content from a ToolResult's ContentBlock array */
function extractText(result: ToolResult): string {
  return result.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
}

// --- Constants ---

const SMOKE_DIR = join(tmpdir(), `nimblebrain-smoke-${Date.now()}`);

const ECHO_BUNDLE_NAME = "@nimblebraininc/echo";
const ECHO_CACHE_NAME = "nimblebraininc-echo";
const ECHO_BUNDLE_PATH = join(homedir(), ".mpak", "cache", ECHO_CACHE_NAME);

// --- Setup ---

mkdirSync(SMOKE_DIR, { recursive: true });

beforeAll(() => {
  // Pull the echo bundle from mpak registry if not already cached.
  // `mpak bundle pull` downloads a .mcpb (zip) to cwd — extract it to the cache dir.
  if (!existsSync(join(ECHO_BUNDLE_PATH, "manifest.json"))) {
    execSync(`mpak bundle pull ${ECHO_BUNDLE_NAME}`, { stdio: "inherit", cwd: SMOKE_DIR });

    // Find the downloaded .mcpb file and extract to cache
    const mcpbFiles = readdirSync(SMOKE_DIR).filter((f) => f.endsWith(".mcpb"));
    if (mcpbFiles.length === 0) {
      throw new Error("mpak bundle pull succeeded but no .mcpb file found");
    }
    const mcpbPath = join(SMOKE_DIR, mcpbFiles[0]);
    mkdirSync(ECHO_BUNDLE_PATH, { recursive: true });
    execSync(`unzip -o "${mcpbPath}" -d "${ECHO_BUNDLE_PATH}"`, { stdio: "inherit" });
  }
  if (!existsSync(join(ECHO_BUNDLE_PATH, "manifest.json"))) {
    throw new Error(
      `Echo bundle not found at ${ECHO_BUNDLE_PATH} after mpak pull. ` +
        `Ensure mpak is installed and ${ECHO_BUNDLE_NAME} is available on the registry.`,
    );
  }
});

afterAll(() => {
  // Force-kill any CLI children that outlived their tests
  for (const child of activeChildren) {
    child.kill("SIGKILL");
  }
  activeChildren.clear();
  if (existsSync(SMOKE_DIR)) rmSync(SMOKE_DIR, { recursive: true });
});

/** Build an McpSource for the echo bundle using the mpak cache. */
function createEchoSource(): McpSource {
  const raw = JSON.parse(readFileSync(join(ECHO_BUNDLE_PATH, "manifest.json"), "utf-8"));
  const result = validateManifest(raw);
  const manifest = result.manifest!;
  const mcpConfig = manifest.server.mcp_config;

  let command = mcpConfig.command;
  const args = (mcpConfig.args ?? []).map((arg) =>
    arg.replace(/\$\{__dirname\}/g, resolve(ECHO_BUNDLE_PATH)),
  );

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(mcpConfig.env ?? {}),
  };

  // Python PYTHONPATH setup
  if (manifest.server.type === "python") {
    if (command === "python") {
      const check = Bun.spawnSync(["which", "python"]);
      if (check.exitCode !== 0) command = "python3";
    }
    const resolvedDir = resolve(ECHO_BUNDLE_PATH);
    const pathParts: string[] = [];
    const depsDir = join(resolvedDir, "deps");
    if (existsSync(depsDir)) pathParts.push(depsDir);
    const srcDir = join(resolvedDir, "src");
    if (existsSync(srcDir)) pathParts.push(srcDir);
    if (pathParts.length > 0) {
      const existing = env["PYTHONPATH"];
      env["PYTHONPATH"] = existing ? `${pathParts.join(":")}:${existing}` : pathParts.join(":");
    }
  }

  return new McpSource("echo", {
    type: "stdio",
    spawn: { command, args, env, cwd: resolve(ECHO_BUNDLE_PATH) },
  });
}

// --- Manifest validation ---

describe("Smoke: Manifest validation", () => {
  it("validates the real echo bundle manifest against MCPB v0.4 schema", () => {
    const raw = JSON.parse(readFileSync(join(ECHO_BUNDLE_PATH, "manifest.json"), "utf-8"));
    const result = validateManifest(raw);

    expect(result.valid).toBe(true);
    expect(["0.3", "0.4"]).toContain(result.version);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.name).toBe(ECHO_BUNDLE_NAME);
    expect(result.manifest!.server.type).toBe("python");
    expect(result.manifest!.server.mcp_config.command).toBe("python");
  });

  it("rejects manifests with missing version", () => {
    const result = validateManifest({ name: "test", version: "1.0" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Missing manifest_version");
  });

  it("rejects manifests with unsupported version", () => {
    const result = validateManifest({ manifest_version: "0.1", name: "test" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Unsupported");
  });

  it("rejects manifests missing required fields", () => {
    const result = validateManifest({ manifest_version: "0.4", name: "test" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// --- Real echo bundle: McpSource + ToolRegistry integration ---

describe("Smoke: Real echo bundle (Python/FastMCP)", () => {
  it("spawns the echo server and discovers 3 tools", async () => {
    const source = createEchoSource();
    await source.start();

    const tools = await source.tools();
    expect(tools.length).toBeGreaterThanOrEqual(3);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames.some((n) => n.includes("echo_message"))).toBe(true);
    expect(toolNames.some((n) => n.includes("echo_with_delay"))).toBe(true);
    expect(toolNames.some((n) => n.includes("echo_json"))).toBe(true);

    await source.stop();
  }, 30_000);

  it("executes echo_message and gets a valid response", async () => {
    const source = createEchoSource();
    await source.start();

    const result = await source.execute("echo_message", {
      message: "Hello from smoke test!",
      uppercase: false,
    });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(extractText(result));
    expect(parsed.original_message).toBe("Hello from smoke test!");
    expect(parsed.echoed_message).toBe("Hello from smoke test!");
    expect(parsed.uppercase_applied).toBe(false);
    expect(parsed.message_length).toBe(22);
    expect(parsed.timestamp).toBeDefined();

    await source.stop();
  }, 30_000);

  it("executes echo_message with uppercase flag", async () => {
    const source = createEchoSource();
    await source.start();

    const result = await source.execute("echo_message", {
      message: "smoke test",
      uppercase: true,
    });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(extractText(result));
    expect(parsed.echoed_message).toBe("SMOKE TEST");
    expect(parsed.uppercase_applied).toBe(true);

    await source.stop();
  }, 30_000);

  it("executes echo_json with structured data", async () => {
    const source = createEchoSource();
    await source.start();

    const result = await source.execute("echo_json", {
      data: { key: "value", count: 42, nested: { a: true } },
    });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(extractText(result));
    expect(parsed.original_data.key).toBe("value");
    expect(parsed.original_data.count).toBe(42);
    expect(parsed.analysis.key_count).toBe(3);
    expect(parsed.analysis.keys).toContain("key");

    await source.stop();
  }, 30_000);

  it("returns error for nonexistent tool via ToolRegistry", async () => {
    const source = createEchoSource();
    await source.start();

    const registry = new ToolRegistry();
    registry.addSource(source);

    const result = await registry.execute({
      id: "smoke_err",
      name: "echo__nonexistent",
      input: {},
    });

    expect(result.isError).toBe(true);

    await registry.removeSource("echo");
  }, 30_000);

  it("lists tools through ToolRegistry", async () => {
    const source = createEchoSource();
    await source.start();

    const registry = new ToolRegistry();
    registry.addSource(source);

    const tools = await registry.availableTools();
    expect(tools.length).toBeGreaterThanOrEqual(3);
    expect(tools.some((t) => t.name === "echo__echo_message")).toBe(true);

    await registry.removeSource("echo");
  }, 30_000);
});

// --- Runtime integration with real echo bundle ---

describe("Smoke: Runtime with real echo bundle", () => {
  it("starts runtime with echo bundle by name and exposes tools via registry", async () => {
    const bundleWorkDir = join(SMOKE_DIR, "echo-runtime");
    mkdirSync(bundleWorkDir, { recursive: true });

    // Pre-create workspace with echo bundle so startWorkspaceBundles picks it up
    const wsStore = new WorkspaceStore(bundleWorkDir);
    const slug = TEST_WORKSPACE_ID.startsWith("ws_") ? TEST_WORKSPACE_ID.slice(3) : TEST_WORKSPACE_ID;
    const ws = await wsStore.create("Test Workspace", slug);
    await wsStore.addMember(ws.id, DEV_IDENTITY.id, "admin");
    await wsStore.update(ws.id, { bundles: [{ name: ECHO_BUNDLE_NAME }] });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      store: { type: "memory" },
      workDir: bundleWorkDir,
    });

    const tools = await runtime.availableTools();
    expect(tools.some((t) => t.name.includes("echo_message"))).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(3);

    await runtime.shutdown();
  }, 30_000);
});

// --- Conversation persistence ---

describe("Smoke: Conversation persistence", () => {
  const convWorkDir = join(tmpdir(), `nimblebrain-smoke-conv-${Date.now()}`);
  const convDir = join(convWorkDir, "conversations");
  mkdirSync(convDir, { recursive: true });

  afterAll(() => {
    if (existsSync(convWorkDir)) rmSync(convWorkDir, { recursive: true });
  });

  it("persists conversations to isolated workDir", async () => {
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir: convWorkDir,
      logging: { disabled: true },
    });
    await provisionTestWorkspace(runtime);

    const store = runtime.getStore(TEST_WORKSPACE_ID) as JsonlConversationStore;
    const wsConvDir = join(convWorkDir, "workspaces", TEST_WORKSPACE_ID, "conversations");

    const result = await runtime.chat({ message: "Smoke test message", workspaceId: TEST_WORKSPACE_ID });
    expect(result.conversationId).toMatch(/^conv_/);
    expect(result.response).toBe("Smoke test message");

    await store.flush();

    const files = readdirSync(wsConvDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);

    const result2 = await runtime.chat({
      message: "Follow-up",
      conversationId: result.conversationId,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(result2.conversationId).toBe(result.conversationId);
    expect(readdirSync(wsConvDir).filter((f) => f.endsWith(".jsonl")).length).toBe(1);

    await runtime.shutdown();
    await store.flush();
  });
});

// --- Event observability ---

describe("Smoke: Event observability", () => {
  it("emits run.start and run.done events", async () => {
    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      events: [sink],
      workDir: SMOKE_DIR,
    });
    await provisionTestWorkspace(runtime);

    await runtime.chat({ message: "Event test", workspaceId: TEST_WORKSPACE_ID });

    expect(events.map((e) => e.type)).toContain("run.start");
    expect(events.map((e) => e.type)).toContain("run.done");

    await runtime.shutdown();
  });
});

// --- Skill matching ---

describe("Smoke: Skill matching", () => {
  it("matches skills from custom dir", async () => {
    const skillDir = join(SMOKE_DIR, "skills");
    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, "diagnostics.md"),
      `---
name: diagnostics
description: System diagnostics
version: 1.0.0
metadata:
  keywords: [health, status, diagnostic, check]
  triggers: ["check health", "run diagnostics"]
---

You are a system diagnostics agent.
`,
    );

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      skillDirs: [skillDir],
      workDir: SMOKE_DIR,
    });
    await provisionTestWorkspace(runtime);

    const result = await runtime.chat({ message: "check health and run diagnostics", workspaceId: TEST_WORKSPACE_ID });
    expect(result.skillName).toBe("diagnostics");

    await runtime.shutdown();
  });
});

// --- Headless CLI ---

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");

/** Track spawned CLI children so we can force-kill any survivors on cleanup. */
const activeChildren = new Set<ReturnType<typeof spawn>>();

function runCli(
  input: string,
  opts: { json?: boolean; workDir?: string; configPath?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = opts.timeoutMs ?? 20_000;

  return new Promise((resolvePromise) => {
    const cliArgs = [CLI_PATH];
    if (opts.json) cliArgs.push("--json");
    if (opts.workDir) cliArgs.push("--workdir", opts.workDir);
    if (opts.configPath) cliArgs.push("--config", opts.configPath);

    const child = spawn("bun", ["run", ...cliArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      resolvePromise({ stdout, stderr, exitCode: code });
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      child.kill("SIGKILL");
      finish(1);
    }, timeout);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => finish(code ?? 0));

    child.stdin.write(input);
    child.stdin.end();
  });
}

describe("Smoke: Headless CLI (pipe mode)", () => {
  const headlessDir = join(SMOKE_DIR, "headless");
  const configPath = join(headlessDir, "nimblebrain.json");

  it("starts, skips empty lines, and shuts down cleanly", async () => {
    mkdirSync(headlessDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ noDefaultBundles: true, store: { type: "memory" } }, null, 2),
    );

    const result = await runCli("\n\n", { workDir: headlessDir, configPath });

    expect(result.stderr).toContain("[nimblebrain] Starting runtime");
    expect(result.stderr).toContain("[nimblebrain] Ready");
    expect(result.stderr).toContain("[nimblebrain] Shutting down");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it("exits cleanly on immediate EOF", async () => {
    mkdirSync(headlessDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ noDefaultBundles: true, store: { type: "memory" } }, null, 2),
    );

    const result = await runCli("", { workDir: headlessDir, configPath });

    expect(result.stderr).toContain("[nimblebrain] Ready");
    expect(result.stderr).toContain("[nimblebrain] Shutting down");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
