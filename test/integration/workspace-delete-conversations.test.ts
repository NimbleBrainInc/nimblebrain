/**
 * A purge removes a deleted workspace's conversations through the conversations
 * plugin (`delete_workspace`). With a retention window of 0 it runs inside the
 * delete.
 *
 * - Once the workspace is deleted no new conversation can be created in it, and
 *   the purge waits for a create already past the workspace check, so a create
 *   racing the delete leaves no conversation behind.
 * - The purge is the host's call, walled to the workspace with no owner, so a
 *   workspace deleted with no signed-in identity is purged all the same.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "../../src/conversation/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ownerConversationsDir } from "../helpers/conversation-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const WS_ID = "ws_5d1e7e0c0a7a11e5";
const OWNER = DEV_IDENTITY.id;
const MODEL = "anthropic:claude-sonnet-4-6";

let workDir: string;
let runtime: Runtime;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-ws-delete-conversations-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
    workspaces: { deletedRetentionDays: 0 },
  });
  await seedWorkspace(runtime.getWorkspaceStore(), WS_ID, {
    members: [{ userId: OWNER, role: "admin" }],
  });
});

afterEach(async () => {
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

/** The conversation files the plugin holds for the owner in the workspace. */
function storedConversations(): string[] {
  const dir = ownerConversationsDir(workDir, WS_ID, OWNER);
  return existsSync(dir) ? readdirSync(dir) : [];
}

function create(): Promise<Conversation> {
  return runtime
    .workspaceConversationStore(WS_ID, OWNER)
    .create({ model: MODEL, ownerId: OWNER, workspaceId: WS_ID });
}

function deleteAs(identity: typeof DEV_IDENTITY | undefined) {
  return runWithRequestContext({ identity: identity ?? null, workspaceId: WS_ID }, () =>
    runtime.deleteWorkspace(WS_ID),
  );
}

describe("workspace delete with a window of 0: tombstone, then purge", () => {
  test("a create racing the delete leaves no conversation in the deleted workspace", async () => {
    await create();
    // A create that reaches the store at the moment the workspace is deleted:
    // it passes the workspace check and is in flight while the delete goes on.
    const store = runtime.getWorkspaceStore();
    const remove = store.delete.bind(store);
    let racing: Promise<Conversation> | undefined;
    const spy = spyOn(store, "delete").mockImplementation(async (wsId, opts) => {
      racing = create();
      return remove(wsId, opts);
    });
    try {
      const result = await deleteAs(DEV_IDENTITY);
      expect(result.deleted).toBe(true);
      expect(result.purge?.error).toBeUndefined();
      expect(result.purge?.purged).toBe(true);
    } finally {
      spy.mockRestore();
    }
    await Promise.allSettled([racing]);
    expect(racing).toBeDefined();
    expect(storedConversations()).toEqual([]);

    // After the delete no conversation can be created in the workspace at all.
    await expect(create()).rejects.toThrow();
    expect(storedConversations()).toEqual([]);
  });

  test("a workspace deleted with no signed-in identity is purged at once", async () => {
    await create();
    await create();
    expect(storedConversations()).toHaveLength(2);

    // The purge is the host's call, walled to the workspace: it needs no owner.
    const result = await deleteAs(undefined);
    expect(result.deleted).toBe(true);
    expect(result.purge).toEqual({ purged: true, connectors: [] });
    expect(storedConversations()).toEqual([]);
    expect(await runtime.getWorkspaceStore().getDeleted(WS_ID)).toBeNull();
  });
});
