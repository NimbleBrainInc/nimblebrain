// ---------------------------------------------------------------------------
// api/client.ts — workspace-scoped routes name the workspace in the path
//
// Every workspace-scoped REST helper calls `/v1/workspaces/<active wsId>/…`,
// built per request from the active workspace. With no active workspace the
// helper throws before any request goes out: it never falls back to a route
// that names none, and it never sends a workspace in a header.
//
// The assertions go through `workspacePath` and through helpers no other suite
// replaces with `mock.module` (getShell, chat, startChatTurn), so they hold in
// the full run as well as alone.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApiClientError,
  chat,
  getActiveWorkspaceId,
  getShell,
  setActiveWorkspaceId,
  startChatTurn,
  workspacePath,
} from "./client";

interface Sent {
  url: string;
  headers: Record<string, string>;
}

let originalFetch: typeof globalThis.fetch;
let previousWorkspace: string | null;
let sent: Sent[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousWorkspace = getActiveWorkspaceId();
  sent = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    sent.push({ url, headers });
    const body = url.endsWith("/chat/start")
      ? { conversationId: "conv_0000000000000000" }
      : { placements: [], chatEndpoint: "", eventsEndpoint: "" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setActiveWorkspaceId(previousWorkspace);
});

describe("workspacePath", () => {
  test("builds the active workspace's path", () => {
    setActiveWorkspaceId("ws_acme");
    expect(workspacePath("/tools/call")).toBe("/v1/workspaces/ws_acme/tools/call");
  });

  test("follows a workspace switch on the next call", () => {
    setActiveWorkspaceId("ws_acme");
    expect(workspacePath("/shell")).toBe("/v1/workspaces/ws_acme/shell");
    setActiveWorkspaceId("ws_tenant_a");
    expect(workspacePath("/shell")).toBe("/v1/workspaces/ws_tenant_a/shell");
  });

  test("throws when no workspace is active", () => {
    setActiveWorkspaceId(null);
    expect(() => workspacePath("/tools/call")).toThrow(ApiClientError);
    try {
      workspacePath("/tools/call");
    } catch (err) {
      expect((err as ApiClientError).code).toBe("no_active_workspace");
    }
  });
});

describe("workspace-scoped helpers", () => {
  test("call the active workspace's routes and send no workspace header", async () => {
    setActiveWorkspaceId("ws_acme");
    await getShell();
    await chat({ message: "hi" });
    await startChatTurn({ message: "hi" });
    expect(sent.map((s) => new URL(s.url, "https://nb.example.com").pathname)).toEqual([
      "/v1/workspaces/ws_acme/shell",
      "/v1/workspaces/ws_acme/chat",
      "/v1/workspaces/ws_acme/chat/start",
    ]);
    for (const request of sent) expect(request.headers["x-workspace-id"]).toBeUndefined();
  });

  test("reject with no active workspace, and nothing goes out", async () => {
    setActiveWorkspaceId(null);
    for (const call of [
      () => getShell(),
      () => chat({ message: "hi" }),
      () => startChatTurn({ message: "hi" }),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiClientError);
      expect((err as ApiClientError).code).toBe("no_active_workspace");
    }
    expect(sent).toEqual([]);
  });
});
