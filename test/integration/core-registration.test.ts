import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-core-reg-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  const workDir = join(testDir, "work");
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
    workDir,
    logging: { disabled: true },
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// =============================================================================
// 1. Runtime has nb__ tools after startup
// =============================================================================

describe("nb-core registration in Runtime", () => {
  it("registry contains 'nb' source after startup", () => {
    const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
    expect(registry.hasSource("nb")).toBe(true);
  });

  it("nb__ tools appear in availableTools()", async () => {
    const tools = await runtime.availableTools();
    const coreTools = tools.filter((t) => t.name.startsWith("nb__"));
    expect(coreTools.length).toBeGreaterThanOrEqual(6);
    const names = coreTools.map((t) => t.name).sort();
    expect(names).toContain("nb__set_preferences");
  });

  it("nb__ tools are callable via ToolRegistry.execute()", async () => {
    const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
    const result = await runWithRequestContext(
      { identity: null, workspaceId: TEST_WORKSPACE_ID },
      () =>
        registry.execute({
          id: "test-core-exec",
          name: "nb__workspace_info",
          input: {},
        }),
    );
    expect(result.isError).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(typeof data.version).toBe("string");
  });
});

// =============================================================================
// 2. Resource serving via GET /v1/workspaces/:wsId/apps/nb/resources/:path
// =============================================================================

describe("GET /v1/workspaces/:wsId/apps/nb/resources/:path", () => {
  it("returns 404 for unknown core resource", async () => {
    const res = await fetch(
      `${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/apps/nb/resources/unknown`,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("resource_not_found");
  });
});

// =============================================================================
// 3. Tool call proxy with server=nb
// =============================================================================

describe("POST /v1/workspaces/:wsId/tools/call with server=nb", () => {
  it("calls nb__workspace_info and returns data", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server: "nb",
        tool: "workspace_info",
        arguments: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isError).toBe(false);
    expect(Array.isArray(body.content)).toBe(true);
  });

  it("returns 404 for unknown tool on nb server", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server: "nb",
        tool: "nonexistent_tool",
        arguments: {},
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("tool_not_found");
  });
});

describe("POST /v1/workspaces/:wsId/tools/call with an identity source (conversations)", () => {
  // conversations is a kernel identity source — absent from workspace
  // registries. The REST tool-call path must resolve it through the identity
  // door (like /mcp), not the workspace registry in the path, which would 404
  // "not found on server".
  it("routes conversations__list through the identity door", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "conversations", tool: "list", arguments: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isError).toBe(false);
  });

  it("routes conversations__search through the identity door", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server: "conversations",
        tool: "search",
        arguments: { query: "anything" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isError).toBe(false);
  });
});
