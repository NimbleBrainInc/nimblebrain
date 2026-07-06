// ---------------------------------------------------------------------------
// T009 — Web shell teardown acceptance tests
//
// Pins the contract the task spec calls out:
//
//   1. `ChatRequest` (the shape the chat composer POSTs to /v1/chat/stream)
//      has NO `workspaceId` field — matches T006's identity-bound session
//      contract. A type-level mutual-extends assertion catches future
//      widening at compile time.
//   2. `WorkspaceSwitcher` / `WorkspaceSelector` (the header switcher Q1
//      deletes) is gone from `web/src/` — no source file imports or
//      mentions either name. A "moved to a different file" interpretation
//      of Q1 would still leave matches behind.
//   3. `setActiveWorkspaceId` is exported (T013 calls it from the sidebar).
//
// Runtime fetch contracts are pinned elsewhere to keep this file free of
// `globalThis.fetch` stubbing (which is fragile across the suite's
// mock.module + dynamic-import patterns):
//
//   - `setActiveWorkspaceId` → bridge session reuse (Q3 regression):
//     `mcp-bridge-client.test.ts` ("bridge session lifecycle vs
//     auth/workspace setters").
//   - Per-request `X-Workspace-Id` flows through the bridge:
//     `mcp-bridge-client.test.ts` ("per-request header generation").
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
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
// A data call that fails with `workspace_error` (stale/invalid
// X-Workspace-Id: deleted workspace, lost membership, malformed id) fires the
// registered handler so the shell can drop the selection and route home —
// symmetric to the 401 → onAuthError path. The error is still returned so
// callers' local handling is unchanged.
//
// Asserted on `errorFromResponse` (the seam where the hook fires) rather than
// through `callTool` → fetch: this file pins the REAL `../api/client` early,
// and a pure-function assertion sidesteps the suite's `mock.module(...)` /
// `globalThis.fetch` fragility that makes a `callTool` round-trip unreliable.
//
// Regression guard: production users hit raw
// `{"error":"workspace_error","message":"Workspace \"ws_..\" not found."}`
// JSON mid-session when a stale X-Workspace-Id reached a data fetch with no
// route guard in front of it.
// ---------------------------------------------------------------------------

describe("errorFromResponse → onWorkspaceError recovery hook", () => {
  test("fires onWorkspaceError for a workspace_error body and returns the error", () => {
    const fired = mock(() => {});
    setOnWorkspaceError(fired);

    const err = errorFromResponse(
      { error: "workspace_error", message: 'Workspace "ws_empty" not found.' },
      400,
    );

    expect(fired).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.code).toBe("workspace_error");
    expect(err.status).toBe(400);
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

    errorFromResponse({ error: "workspace_error", message: "stale" }, 400);

    expect(fired).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Switcher fully deleted (Q1, locked 2026-05-22)
// ---------------------------------------------------------------------------

describe("WorkspaceSwitcher / WorkspaceSelector teardown", () => {
  test("no source file imports or names the deleted component", async () => {
    // Walk web/src/ and assert neither `WorkspaceSwitcher` (the name
    // the task spec uses) nor `WorkspaceSelector` (the name it had
    // pre-T009) appears in any source file. A "moved to a different
    // file" interpretation of Q1 would still leave matches behind.
    //
    // This very test file contains the strings as documentation —
    // skip `__tests__` and `_generated`.
    const webSrc = join(import.meta.dir, "..");
    const offenders = await findOffenders(
      webSrc,
      ["WorkspaceSwitcher", "WorkspaceSelector"],
      ["__tests__", "_generated"],
    );
    expect(offenders).toEqual([]);
  });
});

/** True for a TypeScript source filename (`.ts` / `.tsx`). */
function isSourceFile(name: string): boolean {
  return /\.(ts|tsx)$/.test(name);
}

/** The first needle contained in `body`, or `null` when none match. */
function firstNeedleIn(body: string, needles: string[]): string | null {
  for (const needle of needles) {
    if (body.includes(needle)) return needle;
  }
  return null;
}

/** Route one directory entry: push sub-dirs to `stack` (minus `skipDirNames`), source files to `files`. */
function visitEntry(
  ent: Dirent,
  dir: string,
  stack: string[],
  files: string[],
  skipDirNames: string[],
): void {
  const path = join(dir, ent.name);
  if (ent.isDirectory()) {
    if (!skipDirNames.includes(ent.name)) stack.push(path);
    return;
  }
  if (!ent.isFile()) return;
  if (isSourceFile(ent.name)) files.push(path);
}

/** All `.ts`/`.tsx` files under `root`, skipping directories named in `skipDirNames`. */
async function collectSourceFiles(root: string, skipDirNames: string[]): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      visitEntry(ent, dir, stack, files, skipDirNames);
    }
  }
  return files;
}

/** Source files under `root` that contain any of `needles`, one message per offending file. */
async function findOffenders(
  root: string,
  needles: string[],
  skipDirNames: string[],
): Promise<string[]> {
  const offenders: string[] = [];
  for (const path of await collectSourceFiles(root, skipDirNames)) {
    const body = await readFile(path, "utf-8");
    const hit = firstNeedleIn(body, needles);
    if (hit) offenders.push(`${path}: contains "${hit}"`);
  }
  return offenders;
}
