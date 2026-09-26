/**
 * Resume → file rehydration partition.
 *
 * A conversation is WORKSPACE-owned: it lives under `workspaces/<wsId>/...` and
 * its attached files live in the SAME workspace's partition
 * (`workspaces/<wsId>/files/<ownerId>/`). A turn runs in the workspace its
 * request names, and a resume names the conversation's own workspace or is
 * refused as an unknown conversation (ADR-0037). So the file store that
 * rehydrates `files://` attachments is that one workspace's, and a resume from
 * anywhere else reads nothing at all.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileStore } from "../../../src/files/store.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { ConversationNotFoundError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-resume-file-rehydration-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// The conversation's workspace (a focused workspace, the chat is born here).
const WORKSPACE_A = "ws_workspace_a";
// Dev mode: no identity on the request → the dev owner.
const OWNER = DEV_IDENTITY.id;
// An UNFOCUSED request falls back to the owner's personal workspace — a
// different workspace than WORKSPACE_A.
const PERSONAL = personalWorkspaceIdFor(OWNER);

describe("a resume rehydrates files from the workspace it runs in", () => {
  it("a file attached in workspace A is found on a resume in A, and a resume from elsewhere reads nothing", async () => {
    const workDir = join(testDir, "rehydrate-from-workspace");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
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

    // Sanity: the personal workspace does NOT hold the file. So "found" can only
    // mean "resolved to workspace A".
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

    // 4) A resume UNFOCUSED (no workspaceId → the personal workspace) is refused
    //    before any partition is opened: the conversation is not there.
    await expect(
      runtime.chat({ message: "resume from elsewhere", conversationId: convId }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(calls).toEqual([]);

    // 5) The resume in A rehydrates from A.
    await runtime.chat({ message: "resume in A", conversationId: convId, workspaceId: WORKSPACE_A });

    runtime.getWorkspaceFileStore = origGetFileStore;

    // Every partition the resume touched is the conversation's workspace (A).
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
