import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceResolutionError,
  resolveWorkspace,
} from "../../../src/api/auth-middleware.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import type { OrgRole } from "../../../src/identity/types.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

// ── Test helpers ──────────────────────────────────────────────────

let workDir: string;
let workspaceStore: WorkspaceStore;

function makeIdentity(overrides?: Partial<UserIdentity>): UserIdentity {
  return {
    id: "usr_testuser",
    email: "test@example.com",
    displayName: "Test User",
    orgRole: "admin" as OrgRole,
    ...overrides,
  };
}

function makeRequest(
  headers?: Record<string, string>,
): Request {
  return new Request("http://localhost:27247/v1/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ message: "hello" }),
  });
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-ws-ctx-test-"));
  workspaceStore = new WorkspaceStore(workDir);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("resolveWorkspace", () => {
  it("resolves explicit X-Workspace-Id header", async () => {
    const ws = await workspaceStore.create("Explicit WS");
    const identity = makeIdentity();
    await workspaceStore.addMember(ws.id, identity.id, "admin");

    const req = makeRequest({ "x-workspace-id": ws.id });
    const resolved = await resolveWorkspace(req, identity, workspaceStore);

    expect(resolved).toBe(ws.id);
  });

  it("rejects single-workspace users without an explicit header (honest contract)", async () => {
    // Silent single-workspace resolution was a footgun: a client that worked
    // with one workspace would break as soon as the user joined a second.
    // The resolver now requires explicit addressing on every data-path request.
    const identity = makeIdentity({ id: "usr_singlews" });
    const ws = await workspaceStore.create("Single WS");
    await workspaceStore.addMember(ws.id, identity.id, "member");

    const req = makeRequest();

    try {
      await resolveWorkspace(req, identity, workspaceStore);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceResolutionError);
      const wsErr = err as WorkspaceResolutionError;
      expect(wsErr.statusCode).toBe(400);
      expect(wsErr.message).toContain("X-Workspace-Id");
    }
  });

  it("rejects multi-workspace users without an explicit header", async () => {
    const identity = makeIdentity({ id: "usr_multiws" });
    const ws1 = await workspaceStore.create("Multi WS 1");
    const ws2 = await workspaceStore.create("Multi WS 2");
    await workspaceStore.addMember(ws1.id, identity.id, "member");
    await workspaceStore.addMember(ws2.id, identity.id, "member");

    const req = makeRequest();

    try {
      await resolveWorkspace(req, identity, workspaceStore);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceResolutionError);
      const wsErr = err as WorkspaceResolutionError;
      expect(wsErr.statusCode).toBe(400);
      expect(wsErr.message).toContain("X-Workspace-Id");
    }
  });

  it("does not auto-provision — rejects users with no workspace", async () => {
    // Provisioning happens at the identity boundary (provider.provisionUser),
    // not here. If a request arrives with an authenticated user but no
    // workspace, that's an upstream invariant violation, not something the
    // resolver should paper over by creating state on the data path.
    const identity = makeIdentity({ id: "usr_nows", displayName: "Test User" });
    const req = makeRequest();

    try {
      await resolveWorkspace(req, identity, workspaceStore);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceResolutionError);
      const wsErr = err as WorkspaceResolutionError;
      expect(wsErr.statusCode).toBe(400);
    }

    // No workspace was silently created for this user.
    const createdFor = await workspaceStore.getWorkspacesForUser("usr_nows");
    expect(createdFor).toHaveLength(0);
  });

  it("returns 403 when user is not a member of the specified workspace", async () => {
    const ws = await workspaceStore.create("Forbidden WS");
    // Don't add the identity as a member
    const identity = makeIdentity({ id: "usr_nonmember" });

    const req = makeRequest({ "x-workspace-id": ws.id });

    try {
      await resolveWorkspace(req, identity, workspaceStore);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceResolutionError);
      const wsErr = err as WorkspaceResolutionError;
      expect(wsErr.statusCode).toBe(403);
      expect(wsErr.message).toContain("Access denied");
    }
  });

  it("returns 400 when X-Workspace-Id references a non-existent workspace", async () => {
    const identity = makeIdentity({ id: "usr_badref" });
    const req = makeRequest({ "x-workspace-id": "ws_doesnotexist" });

    try {
      await resolveWorkspace(req, identity, workspaceStore);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceResolutionError);
      const wsErr = err as WorkspaceResolutionError;
      expect(wsErr.statusCode).toBe(400);
      expect(wsErr.message).toContain("not found");
    }
  });

});

describe("ChatRequest/ChatResult workspaceId", () => {
  it("ChatRequest type accepts workspaceId field", async () => {
    // Type-level check — if this compiles, the type is correct
    const { ChatRequest } = await import("../../../src/runtime/types.ts");
    const req = {
      message: "test",
      workspaceId: "ws_test",
    } satisfies import("../../../src/runtime/types.ts").ChatRequest;
    expect(req.workspaceId).toBe("ws_test");
  });

  it("ChatResult type accepts workspaceId field", async () => {
    const result = {
      response: "hello",
      conversationId: "conv_1",
      workspaceId: "ws_test",
      skillName: null,
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 50,
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        costUsd: 0.001,
        model: "test",
        llmMs: 500,
        iterations: 1,
      },
    } satisfies import("../../../src/runtime/types.ts").ChatResult;
    expect(result.workspaceId).toBe("ws_test");
  });
});
