/**
 * Cross-workspace resume → file rehydration partition.
 *
 * A conversation is WORKSPACE-owned: it lives under `workspaces/<wsId>/...` and
 * its attached files live in the SAME workspace's partition
 * (`workspaces/<wsId>/files/<ownerId>/`). On a cross-workspace resume — a
 * request whose focused workspace differs from the conversation's — `chat()`
 * relocates to the conversation's actual workspace via the locator and captures
 * the authoritative `convWsId`. The file store used to rehydrate `files://`
 * attachments MUST be built from THAT `convWsId`, not the request header —
 * otherwise the resumed chat reads the wrong partition and the attachment
 * silently vanishes.
 *
 * This pins that wiring: after a cross-workspace resume, the rehydration file
 * store resolves to the conversation's workspace (A), where the file lives, and
 * finds it — even though the resume request is NOT focused on A.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileStore } from "../../../src/files/store.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-cross-workspace-file-resume-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// The conversation's workspace (a focused workspace, the chat is born here).
const WORKSPACE_A = "ws_workspace_a";
// Dev mode: no identity on the request → the dev owner.
const OWNER = DEV_IDENTITY.id;
// The resume is UNFOCUSED → it falls back to the owner's personal workspace,
// which is a DIFFERENT workspace than WORKSPACE_A. That is the cross-workspace hop.
const PERSONAL = personalWorkspaceIdFor(OWNER);

describe("cross-workspace resume rehydrates files from the conversation's workspace (not the request)", () => {
  it("a file attached in workspace A is found on a resume that is NOT focused on A", async () => {
    const workDir = join(testDir, "rehydrate-from-workspace");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, WORKSPACE_A);

    // 1) Born in workspace A (focused on WORKSPACE_A) — the conversation lives
    //    under workspaces/ws_workspace_a/conversations/<owner>/.
    const born = await runtime.chat({ message: "hello from workspace A", workspaceId: WORKSPACE_A });
    const convId = born.conversationId;

    // 2) Attach a file into workspace A's partition (the same workspace the
    //    conversation lives in). This is the partition the resume must resolve to.
    const fileStoreA = runtime.getWorkspaceFileStore(WORKSPACE_A, OWNER);
    const saved = await fileStoreA.saveFile(Buffer.from("workspace-A bytes"), "attach.txt", "text/plain");
    await fileStoreA.appendRegistry({
      id: saved.id,
      filename: "attach.txt",
      mimeType: "text/plain",
      size: saved.size,
      tags: [],
      source: "chat",
      conversationId: convId,
      createdAt: new Date().toISOString(),
      description: null,
      workspaceId: WORKSPACE_A,
      ownerId: OWNER,
      visibility: "private",
    });

    // Sanity: the personal workspace — where an un-fixed resume would look —
    // does NOT hold the file. So "found" can only mean "resolved to workspace A".
    expect(await runtime.getWorkspaceFileStore(PERSONAL, OWNER).findEntry(saved.id)).toBeNull();

    // 3) Spy on getWorkspaceFileStore to capture the partition rehydration
    //    resolves to. The chat path builds exactly one file store (the
    //    rehydration store) from the authoritative `convWsId`. We capture its
    //    (wsId, store) so we can assert which workspace the resume read from.
    const calls: Array<{ wsId: string; store: FileStore }> = [];
    const origGetFileStore = runtime.getWorkspaceFileStore.bind(runtime);
    runtime.getWorkspaceFileStore = (wsId: string, ownerId: string): FileStore => {
      const store = origGetFileStore(wsId, ownerId);
      calls.push({ wsId, store });
      return store;
    };

    // 4) Cross-workspace resume: UNFOCUSED (no workspaceId) → the request
    //    workspace is the owner's personal workspace, NOT workspace A. chat()
    //    must relocate to A via the locator, and rehydration must follow it.
    await runtime.chat({ message: "resume from elsewhere", conversationId: convId });

    runtime.getWorkspaceFileStore = origGetFileStore;

    // Every partition the resume touched is the conversation's workspace (A) —
    // never the request's personal workspace. (Reverting the fix makes this the
    // personal workspace, and the assertions below fail.)
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.wsId).toBe(WORKSPACE_A);
      expect(c.wsId).not.toBe(PERSONAL);
    }

    // The store rehydration actually used finds the attachment — it is not lost.
    const rehydrationStore = calls[calls.length - 1]!.store;
    const entry = await rehydrationStore.findEntry(saved.id);
    expect(entry).not.toBeNull();
    expect(entry?.workspaceId).toBe(WORKSPACE_A);

    await runtime.shutdown();
  });
});
