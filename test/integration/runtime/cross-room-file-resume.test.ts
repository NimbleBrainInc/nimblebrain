/**
 * Cross-room resume → file rehydration partition.
 *
 * A conversation is ROOM-owned: it lives under `workspaces/<roomWsId>/...` and
 * its attached files live in the SAME room's partition
 * (`workspaces/<roomWsId>/files/<ownerId>/`). On a cross-room resume — a
 * request whose focused workspace differs from the conversation's room —
 * `resolveChatStore` relocates to the conversation's actual room via the
 * locator and returns the authoritative `roomWsId`. The file store used to
 * rehydrate `files://` attachments MUST be built from THAT `roomWsId`, not the
 * request header — otherwise the resumed chat reads the wrong partition and the
 * attachment silently vanishes.
 *
 * This pins that wiring: after a cross-room resume, the rehydration file store
 * resolves to the conversation's room (A), where the file lives, and finds it —
 * even though the resume request is NOT focused on A.
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

const testDir = join(tmpdir(), `nb-cross-room-file-resume-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// The conversation's room (a focused workspace, the chat is born here).
const ROOM_A = "ws_room_a";
// Dev mode: no identity on the request → the dev owner.
const OWNER = DEV_IDENTITY.id;
// The resume is UNFOCUSED → it falls back to the owner's personal room, which
// is a DIFFERENT workspace than ROOM_A. That is the cross-room hop.
const PERSONAL = personalWorkspaceIdFor(OWNER);

describe("cross-room resume rehydrates files from the conversation's room (not the request)", () => {
  it("a file attached in room A is found on a resume that is NOT focused on A", async () => {
    const workDir = join(testDir, "rehydrate-from-room");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, ROOM_A);

    // 1) Born in room A (focused on ROOM_A) — the conversation lives under
    //    workspaces/ws_room_a/conversations/<owner>/.
    const born = await runtime.chat({ message: "hello from room A", workspaceId: ROOM_A });
    const convId = born.conversationId;

    // 2) Attach a file into room A's partition (same room the conversation
    //    lives in). This is the partition the resume must resolve to.
    const fileStoreA = runtime.getFileStore(ROOM_A, OWNER);
    const saved = await fileStoreA.saveFile(Buffer.from("room-A bytes"), "attach.txt", "text/plain");
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
      workspaceId: ROOM_A,
      ownerId: OWNER,
      visibility: "private",
    });

    // Sanity: the personal room — where an un-fixed resume would look — does
    // NOT hold the file. So "found" can only mean "resolved to room A".
    expect(await runtime.getFileStore(PERSONAL, OWNER).findEntry(saved.id)).toBeNull();

    // 3) Spy on getFileStore to capture the partition rehydration resolves to.
    //    `_chatInner` builds exactly one file store (the rehydration store) from
    //    the authoritative `roomWsId`. We capture its (wsId, store) so we can
    //    assert which room the resume read from.
    const calls: Array<{ wsId: string; store: FileStore }> = [];
    const origGetFileStore = runtime.getFileStore.bind(runtime);
    runtime.getFileStore = (wsId: string, ownerId: string): FileStore => {
      const store = origGetFileStore(wsId, ownerId);
      calls.push({ wsId, store });
      return store;
    };

    // 4) Cross-room resume: UNFOCUSED (no workspaceId) → the request room is the
    //    owner's personal workspace, NOT room A. resolveChatStore must relocate
    //    to A via the locator, and rehydration must follow it.
    await runtime.chat({ message: "resume from elsewhere", conversationId: convId });

    runtime.getFileStore = origGetFileStore;

    // Every partition the resume touched is the conversation's room (A) — never
    // the request's personal room. (Reverting the fix makes this the personal
    // room, and the assertions below fail.)
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.wsId).toBe(ROOM_A);
      expect(c.wsId).not.toBe(PERSONAL);
    }

    // The store rehydration actually used finds the attachment — it is not lost.
    const rehydrationStore = calls[calls.length - 1]!.store;
    const entry = await rehydrationStore.findEntry(saved.id);
    expect(entry).not.toBeNull();
    expect(entry?.workspaceId).toBe(ROOM_A);

    await runtime.shutdown();
  });
});
