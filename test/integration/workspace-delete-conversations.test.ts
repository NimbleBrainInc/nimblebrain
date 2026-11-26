/**
 * Deleting a workspace archives it first, then purges its conversations through
 * the conversations plugin (`delete_workspace`).
 *
 * - With the workspace gone no new conversation can be created in it, and the
 *   purge waits for a create already past the workspace check, so a create
 *   racing the delete leaves no conversation in the deleted workspace.
 * - A purge that fails leaves no live workspace: the workspace is already
 *   archived, and deleting the same id again runs the idempotent purge again.
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

describe("workspace delete: archive, then purge", () => {
  test("a create racing the delete leaves no conversation in the deleted workspace", async () => {
    await create();
    // A create that reaches the store at the moment the workspace is archived:
    // it passes the workspace check and is in flight while the delete goes on.
    const store = runtime.getWorkspaceStore();
    const archive = store.delete.bind(store);
    let racing: Promise<Conversation> | undefined;
    const spy = spyOn(store, "delete").mockImplementation(async (wsId: string) => {
      racing = create();
      return archive(wsId);
    });
    try {
      const result = await deleteAs(DEV_IDENTITY);
      expect(result.deleted).toBe(true);
      expect(result.purgeError).toBeUndefined();
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

  test("a failed purge leaves the workspace deleted, and deleting it again purges", async () => {
    await create();
    await create();
    expect(storedConversations()).toHaveLength(2);

    // With no signed-in identity the purge cannot be made, after the archive.
    const failed = await deleteAs(undefined);
    expect(failed.deleted).toBe(true);
    expect(failed.deleteError).toBeUndefined();
    expect(failed.purgeError).toContain("signed-in identity");
    expect(await runtime.getWorkspaceStore().get(WS_ID)).toBeNull();
    expect(storedConversations()).toHaveLength(2);

    const retried = await deleteAs(DEV_IDENTITY);
    expect(retried.deleted).toBe(false);
    expect(retried.purgeError).toBeUndefined();
    expect(retried.conversationsPurged).toBe(2);
    expect(storedConversations()).toEqual([]);
  });
});
