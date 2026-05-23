/**
 * End-to-end coverage: a mutation that violates the personal-workspace
 * invariants returns HTTP 422 with the structured body the spec
 * defines, through the real `/v1/tools/call` surface and the real
 * `manage_workspaces` tool.
 *
 * The unit suite (`test/unit/workspace/personal-workspace-invariants.test.ts`)
 * exhaustively covers the four invariants at the store layer; this file
 * only proves the typed-error → 422 mapping survives the in-process MCP
 * serialization boundary.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startServer, type ServerHandle } from "../../../src/api/server.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { createTestAuthAdapter, TEST_IDENTITY } from "../../helpers/test-auth-adapter.ts";

const API_KEY = "personal-invariant-test-key";

describe("POST /v1/tools/call manage_workspaces — personal workspace invariants → 422", () => {
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let personalWsId: string;
  const workDir = join(tmpdir(), `nimblebrain-personal-invariants-${Date.now()}`);

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });

    // The test adapter provisions a personal workspace for TEST_IDENTITY
    // on first auth — but that's lazy, and we want the row before the
    // tool call runs. Create it explicitly so the route resolves to a
    // real workspace and we have a known target for the invariant
    // violation.
    personalWsId = personalWorkspaceIdFor(TEST_IDENTITY.id);
    const wsStore = runtime.getWorkspaceStore();
    if (!(await wsStore.get(personalWsId))) {
      await wsStore.create("Test User's Workspace", personalWsId.slice(3), {
        isPersonal: true,
        ownerUserId: TEST_IDENTITY.id,
      });
    }
    await runtime.ensureWorkspaceRegistry(personalWsId);

    // Seed a second user so `add_member` reaches the store's
    // PersonalWorkspaceInvariantError path instead of bouncing on the
    // earlier "user not found" check inside the tool handler.
    const userStore = runtime.getUserStore();
    if (!(await userStore.getByEmail("other@example.com"))) {
      await userStore.create({
        id: "usr_other",
        email: "other@example.com",
        displayName: "Other",
        orgRole: "member",
      });
    }

    handle = startServer({
      runtime,
      port: 0,
      provider: createTestAuthAdapter(API_KEY, runtime),
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    handle.stop(true);
    await runtime.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  function callToolHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Workspace-Id": personalWsId,
    };
  }

  it("add_member on a personal workspace returns 422 personal_workspace_invariant", async () => {
    const res = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: callToolHeaders(),
      body: JSON.stringify({
        server: "nb",
        tool: "manage_workspaces",
        arguments: {
          action: "add_member",
          workspaceId: personalWsId,
          userId: "usr_other",
          role: "admin",
        },
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      message: string;
      details?: { workspaceId?: string; reason?: string };
    };
    expect(body.error).toBe("personal_workspace_invariant");
    expect(body.details?.reason).toBe("members_mutation");
    expect(body.details?.workspaceId).toBe(personalWsId);
    // The human message includes context the operator can act on.
    expect(body.message).toContain(personalWsId);
  });

  it("update_member on the owner of a personal workspace returns 422 members_mutation", async () => {
    // role="admin" (a no-op role-wise) bypasses the "cannot demote last
    // admin" pre-check inside the tool handler so the call actually
    // reaches `WorkspaceStore.updateMemberRole`, which is the layer
    // that enforces the invariant. The point of the test is that the
    // store-layer rejection survives the in-process MCP boundary as
    // structuredContent + becomes a 422 at the HTTP boundary.
    const res = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: callToolHeaders(),
      body: JSON.stringify({
        server: "nb",
        tool: "manage_workspaces",
        arguments: {
          action: "update_member",
          workspaceId: personalWsId,
          userId: TEST_IDENTITY.id,
          role: "admin",
        },
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      details?: { reason?: string };
    };
    expect(body.error).toBe("personal_workspace_invariant");
    expect(body.details?.reason).toBe("members_mutation");
  });

  it("normal update (name) on a personal workspace still succeeds — invariant scoped to identity fields", async () => {
    // Topology adversarial: confirm we didn't over-lock. A name update
    // on a personal workspace must continue to work.
    const res = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: callToolHeaders(),
      body: JSON.stringify({
        server: "nb",
        tool: "manage_workspaces",
        arguments: {
          action: "update",
          workspaceId: personalWsId,
          name: "Renamed Personal Workspace",
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { isError: boolean };
    expect(body.isError).toBe(false);
  });
});
