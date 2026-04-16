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

  it("resolves from conversation's workspaceId when no header", async () => {
    const ws = await workspaceStore.create("Conversation WS");
    const identity = makeIdentity({ id: "usr_convuser" });
    await workspaceStore.addMember(ws.id, identity.id, "member");

    // Create a second workspace so auto-resolve wouldn't work
    const ws2 = await workspaceStore.create("Other WS");
    await workspaceStore.addMember(ws2.id, identity.id, "member");

    const req = makeRequest();
    const resolved = await resolveWorkspace(req, identity, workspaceStore, ws.id);

    expect(resolved).toBe(ws.id);
  });

  it("auto-resolves when user has exactly one workspace", async () => {
    const identity = makeIdentity({ id: "usr_singlews" });
    const ws = await workspaceStore.create("Single WS");
    await workspaceStore.addMember(ws.id, identity.id, "member");

    const req = makeRequest();
    const resolved = await resolveWorkspace(req, identity, workspaceStore);

    expect(resolved).toBe(ws.id);
  });

  it("returns 400 when user has multiple workspaces and no header", async () => {
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
      expect(wsErr.message).toContain("Multiple workspaces");
    }
  });

  it("auto-provisions workspace when user has none", async () => {
    const identity = makeIdentity({ id: "usr_nows", displayName: "Test User" });
    const req = makeRequest();

    const wsId = await resolveWorkspace(req, identity, workspaceStore);

    // Should have auto-created a workspace and returned its ID
    expect(wsId).toMatch(/^ws_/);
    const ws = await workspaceStore.get(wsId);
    expect(ws).toBeTruthy();
    expect(ws!.members.some((m) => m.userId === "usr_nows")).toBe(true);
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

  it("header takes precedence over conversation workspaceId", async () => {
    const identity = makeIdentity({ id: "usr_precedence" });
    const wsHeader = await workspaceStore.create("Header WS");
    const wsConv = await workspaceStore.create("Conv WS 2");
    await workspaceStore.addMember(wsHeader.id, identity.id, "admin");
    await workspaceStore.addMember(wsConv.id, identity.id, "member");

    const req = makeRequest({ "x-workspace-id": wsHeader.id });
    const resolved = await resolveWorkspace(req, identity, workspaceStore, wsConv.id);

    expect(resolved).toBe(wsHeader.id);
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
