// ---------------------------------------------------------------------------
// T009 — Web shell teardown acceptance tests
//
// Pins the contract the task spec calls out:
//
//   1. `ChatRequest` (the shape the chat composer POSTs to
//      /v1/workspaces/<wsId>/chat/stream) has NO `workspaceId` field — matches T006's identity-bound session
//      contract. A type-level mutual-extends assertion catches future
//      widening at compile time.
//   2. `setActiveWorkspaceId` is exported (the sidebar's workspace switcher
//      calls it).
//
// Runtime fetch contracts are pinned elsewhere to keep this file free of
// `globalThis.fetch` stubbing (which is fragile across the suite's
// mock.module + dynamic-import patterns):
//
//   - `setActiveWorkspaceId` → the bridge's next request goes to the new
//     `/mcp/<wsId>`: `mcp-bridge-client.test.ts` ("posts to the active
//     workspace's /mcp path, read per request").
//   - `setAuthToken` fires lifecycle handler, `setActiveWorkspaceId`
//     does not: `api-client-lifecycle.test.ts`.
//
// This file reads the REAL `../api/client` (it installs no mock.module of its
// own). The whole-module client mocks in other suites now spread the real
// module, so they never drop an export even when Bun's process-global mock
// registry leaks one across concurrently-loading files — no filename-ordering
// trick required.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";

// Real exports under test — asserted as values/types below.
import {
  ApiClientError,
  errorFromResponse,
  setActiveWorkspaceId,
  setOnWorkspaceError,
} from "../api/client";
import type { ChatRequest } from "../types";

describe("ChatRequest wire shape (T006 contract)", () => {
  test("ChatRequest has exactly the fields T006 codified — no workspaceId", () => {
    // Mutual-extends: catches both widening and narrowing.
    // Adding `workspaceId` (or anything else) would break `backward`;
    // dropping one of the listed keys would break `forward`.
    type ChatRequestKeys = keyof ChatRequest;
    type Expected = "message" | "conversationId" | "model" | "maxIterations" | "appContext";

    const forward: Expected extends ChatRequestKeys ? true : false = true;
    const backward: ChatRequestKeys extends Expected ? true : false = true;
    expect(forward).toBe(true);
    expect(backward).toBe(true);
  });

  test("setActiveWorkspaceId is exported (T013 plumbing — sidebar will call it)", () => {
    // Smoke: the setter must remain a callable export. T013's sidebar
    // depends on it. A regression that deleted the setter alongside the
    // UI would surface here.
    expect(typeof setActiveWorkspaceId).toBe("function");
    // Calling with null is benign and resets state — verify the call
    // doesn't throw.
    expect(() => setActiveWorkspaceId(null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// workspace_error → onWorkspaceError recovery hook
//
// A data call that fails with `workspace_error` (a stale or invalid workspace
// in the request path: deleted workspace, lost membership, malformed id) fires the
// registered handler so the shell can drop the selection and route home —
// symmetric to the 401 → onAuthError path. The error is still returned so
// callers' local handling is unchanged.
//
// Asserted on `errorFromResponse` (the seam where the hook fires) rather than
// through `callTool` → fetch: this file pins the REAL `../api/client` early,
// and a pure-function assertion sidesteps the suite's `mock.module(...)` /
// `globalThis.fetch` fragility that makes a `callTool` round-trip unreliable.
//
// Regression guard: without the hook, a data fetch addressed to a stale
// workspace with no route guard in front of it surfaces the raw
// `{"error":"workspace_error","message":"Workspace not found"}` JSON mid-session.
// ---------------------------------------------------------------------------

describe("errorFromResponse → onWorkspaceError recovery hook", () => {
  test("fires onWorkspaceError for a workspace_error body and returns the error", () => {
    const fired = mock(() => {});
    setOnWorkspaceError(fired);

    const err = errorFromResponse(
      { error: "workspace_error", message: "Workspace not found" },
      404,
    );

    expect(fired).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe("workspace_error");
    expect(err.status).toBe(404);
    setOnWorkspaceError(null);
  });

  test("does NOT fire for unrelated errors", () => {
    const fired = mock(() => {});
    setOnWorkspaceError(fired);

    errorFromResponse({ error: "not_found", message: "nope" }, 404);

    expect(fired).toHaveBeenCalledTimes(0);
    setOnWorkspaceError(null);
  });

  test("does not fire after the handler is cleared", () => {
    const fired = mock(() => {});
    setOnWorkspaceError(fired);
    setOnWorkspaceError(null);

    errorFromResponse({ error: "workspace_error", message: "Workspace not found" }, 404);

    expect(fired).toHaveBeenCalledTimes(0);
  });
});
