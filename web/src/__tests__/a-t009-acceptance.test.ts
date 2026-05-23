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
// File is prefixed `a-` to load early — `mock.module(...)` from
// `connector-sections.test.tsx` later in the suite installs a 5-export
// stub for `../api/client`, and any file importing `setAuthToken` /
// `streamChat` after that fails to resolve. Existing
// `api-client-lifecycle.test.ts` uses the same alphabetical-load trick.
// ---------------------------------------------------------------------------

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Side-effect import to pin the module in the cache with full exports
// before any later test installs a mock.module replacement.
import { setActiveWorkspaceId } from "../api/client";
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

async function findOffenders(
  root: string,
  needles: string[],
  skipDirNames: string[],
): Promise<string[]> {
  const offenders: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirNames.includes(ent.name)) continue;
        stack.push(path);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(ent.name)) continue;
      const body = await readFile(path, "utf-8");
      for (const needle of needles) {
        if (body.includes(needle)) {
          offenders.push(`${path}: contains "${needle}"`);
          break;
        }
      }
    }
  }
  return offenders;
}
