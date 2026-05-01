/**
 * End-to-end contract test for the skills create flow.
 *
 * The original bug (`Invalid arguments for "create": /manifest: must have
 * required property 'name'`) was a contract drift between the web client
 * and the server tool handler — the web sent `name` at the args root, the
 * handler's JSON Schema required `name` inside `manifest`. Three hand-
 * written declarations (server schema literal, server CreateInput, web
 * CreateInput) never agreed.
 *
 * This test posts a payload constructed via the schema-derived type
 * `ToolInput<"skills", "create">` through `/v1/tools/call` and asserts a
 * successful create. If the catalog and the handler ever disagree again,
 * this test fails — restoring the safety net the missing UI test left
 * uncovered.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ToolInput } from "../../src/tools/platform/schemas/catalog.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `skills-create-from-web-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

describe("skills__create — web payload contract", () => {
  it("accepts a payload built from ToolInput<'skills', 'create'>", async () => {
    // The shape below is exactly what `web/src/pages/settings/SkillsTab.tsx`
    // posts now — name lives inside manifest, not at the args root. If the
    // catalog drifts from the handler's schema, TypeScript fails to compile
    // this literal; if the handler's schema rejects this shape at runtime,
    // the assertion below catches it.
    const args: ToolInput<"skills", "create"> = {
      scope: "workspace",
      manifest: {
        name: "phase-one-smoke",
        description: "End-to-end smoke from the web payload contract test",
        type: "skill",
        priority: 50,
        status: "active",
      },
      body: "# Phase One Smoke\n\nThis skill exists to prove the contract.\n",
    };

    const res = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({ server: "skills", tool: "create", arguments: args }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      isError?: boolean;
      structuredContent?: { id?: string; name?: string; scope?: string };
    };
    expect(body.isError).toBeFalsy();
    expect(body.structuredContent?.name).toBe("phase-one-smoke");
    expect(body.structuredContent?.scope).toBe("workspace");
    expect(body.structuredContent?.id).toMatch(/phase-one-smoke\.md$/);
  });

  it("rejects a payload with name at the root (the original bug shape)", async () => {
    // The exact shape SkillsTab used to send — name at the args root,
    // not inside manifest. This must produce a 400 with the JSON Schema
    // validator error, not a successful create. If the handler ever
    // accepts this shape, drift was reintroduced.
    const malformed = {
      scope: "workspace",
      name: "should-fail",
      manifest: {
        description: "no name in manifest",
        type: "skill",
        status: "active",
      },
      body: "irrelevant",
    };

    const res = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: JSON.stringify({ server: "skills", tool: "create", arguments: malformed }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe("invalid_input");
    expect(body.message ?? "").toMatch(/manifest/);
  });
});
