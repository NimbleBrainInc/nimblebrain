/**
 * `POST /v1/tools/call` — a kernel tool called with no workspace (ADR-0043).
 *
 * Pins:
 *   1. A kernel tool that declares it works with no workspace answers there.
 *   2. Every other tool is not found there: an undeclared kernel tool, an
 *      identity source's tool, a connector, an unknown server.
 *   3. A declared tool with both kinds of action refuses, in its own handler,
 *      an action that needs a workspace.
 *   4. The skills listing reads org and user skills with no workspace tier, so
 *      a workspace skill of the same name never hides an org skill there.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiErrorBody, ToolCallResponse } from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { TEST_IDENTITY, testAuthAdapter } from "../helpers/test-auth-adapter.ts";

const API_KEY = "no-workspace-tool-call-test-key";
const testDir = join(tmpdir(), `nb-no-workspace-tool-call-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let wsA: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: testAuthAdapter(API_KEY),
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  wsA = (await runtime.getWorkspaceStore().create("Acme Corp")).id;
  await runtime.getWorkspaceStore().addMember(wsA, TEST_IDENTITY.id, "admin");
  await runtime.ensureWorkspaceRegistry(wsA);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

function call(
  path: string,
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ server, tool, arguments: args }),
  });
}

const noWorkspace = (server: string, tool: string, args?: Record<string, unknown>) =>
  call("/v1/tools/call", server, tool, args);
const inWorkspace = (server: string, tool: string, args?: Record<string, unknown>) =>
  call(`/v1/workspaces/${wsA}/tools/call`, server, tool, args);

function text(body: ToolCallResponse): string {
  const first = body.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("a tool that declares it works with no workspace", () => {
  it("answers on the no-workspace door", async () => {
    for (const [server, tool, args] of [
      ["nb", "get_config", {}],
      ["nb", "manage_workspaces", { action: "list" }],
      ["nb", "manage_users", { action: "list" }],
      ["usage", "report", { scope: "user" }],
    ] as const) {
      const res = await noWorkspace(server, tool, args);
      expect(res.status).toBe(200);
      const body = await readJson<ToolCallResponse>(res);
      expect({ server, tool, isError: body.isError }).toEqual({ server, tool, isError: false });
    }
  });

  it("writes the caller's own preferences", async () => {
    const res = await noWorkspace("nb", "set_preferences", { timezone: "Pacific/Honolulu" });
    expect((await readJson<ToolCallResponse>(res)).isError).toBe(false);
    const user = await runtime.getUserStore().get(TEST_IDENTITY.id);
    expect(user?.preferences.timezone).toBe("Pacific/Honolulu");
  });
});

describe("every other tool is not found on the no-workspace door", () => {
  it("an undeclared kernel tool, an identity tool, an unknown server", async () => {
    for (const [server, tool] of [
      ["nb", "status"],
      ["nb", "search"],
      ["conversations", "list"],
      ["no_such_server", "anything"],
    ] as const) {
      const res = await noWorkspace(server, tool);
      expect({ server, tool, status: res.status }).toEqual({ server, tool, status: 404 });
      expect((await readJson<ApiErrorBody>(res)).error).toBe("tool_not_found");
    }
  });

  it("a workspace header changes nothing", async () => {
    const res = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": wsA,
      },
      body: JSON.stringify({ server: "nb", tool: "status", arguments: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("the same undeclared tool still answers through a workspace", async () => {
    const res = await inWorkspace("nb", "status");
    expect(res.status).toBe(200);
  });
});

describe("a declared tool with workspace actions", () => {
  it("refuses a workspace action when the request names no workspace", async () => {
    const res = await noWorkspace("nb", "manage_connectors", { action: "list_installed" });
    const body = await readJson<ToolCallResponse>(res);
    expect(body.isError).toBe(true);
    expect(text(body)).toContain("names no workspace");
  });

  it("answers a personal action", async () => {
    const res = await noWorkspace("nb", "manage_connectors", {
      action: "list_personal_connectors",
    });
    expect((await readJson<ToolCallResponse>(res)).isError).toBe(false);
  });

  it("answers a workspace action through a workspace", async () => {
    const res = await inWorkspace("nb", "manage_connectors", { action: "list_installed" });
    expect((await readJson<ToolCallResponse>(res)).isError).toBe(false);
  });
});

describe("skills listing with no workspace", () => {
  it("lists an org skill even where a workspace skill of the same name exists", async () => {
    const skill = (description: string) => ({
      manifest: { name: "shared-name", description },
      body: "Body.",
    });
    const org = await noWorkspace("skills", "create", { scope: "org", ...skill("the org one") });
    expect((await readJson<ToolCallResponse>(org)).isError).toBe(false);
    const ws = await inWorkspace("skills", "create", {
      scope: "workspace",
      ...skill("the workspace one"),
    });
    expect((await readJson<ToolCallResponse>(ws)).isError).toBe(false);

    const res = await noWorkspace("skills", "list", { scope: "org" });
    const listed = (await readJson<ToolCallResponse>(res)).structuredContent as {
      skills: Array<{ name: string; description?: string; scope: string }>;
    };
    const shared = listed.skills.filter((s) => s.name === "shared-name");
    expect(shared).toEqual([expect.objectContaining({ scope: "org", description: "the org one" })]);
  });

  it("refuses to create a workspace skill with no workspace", async () => {
    const res = await noWorkspace("skills", "create", {
      scope: "workspace",
      manifest: { name: "nowhere", description: "d" },
      body: "Body.",
    });
    expect((await readJson<ToolCallResponse>(res)).isError).toBe(true);
  });
});
