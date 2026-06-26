/**
 * The cross-room conversation caches (the locator, and via the same hook the
 * conversations-tool index) must invalidate on every write AND on workspace
 * archive-delete — otherwise list views freeze on update / ghost on delete, and
 * a resume could re-create a deleted room's directory.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roomConversationsDir } from "../../../src/conversation/paths.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

const ALICE = { id: "usr_alice", email: "alice@example.com" };
const workDir = join(tmpdir(), `nb-conv-cache-${Date.now()}`);

let runtime: Runtime;
let wsId: string;
let convId: string;

beforeAll(async () => {
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });
  const wsStore = runtime.getWorkspaceStore();
  const ws = await wsStore.create("Helix", "helix");
  wsId = ws.id;
  await wsStore.addMember(wsId, ALICE.id, "admin");
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true });
});

test("an append refreshes the locator summary (list is not frozen)", async () => {
  const r = await runtime.chat({ message: "first", workspaceId: wsId, identity: ALICE });
  convId = r.conversationId;

  let list = await runtime.listConversations({}, { userId: ALICE.id });
  expect(list.totalCount).toBe(1);
  const afterTurn1 = list.conversations[0]?.messageCount ?? 0;

  // Resume — a second turn appends to the same file via the room store.
  await runtime.chat({
    message: "second",
    conversationId: convId,
    workspaceId: wsId,
    identity: ALICE,
  });

  list = await runtime.listConversations({}, { userId: ALICE.id });
  expect(list.totalCount).toBe(1);
  // The summary advanced — the locator re-read the file rather than serving a
  // frozen entry. (Pre-fix it was create/delete-fresh only.)
  expect(list.conversations[0]?.messageCount ?? 0).toBeGreaterThan(afterTurn1);
});

test("workspace delete clears its conversations from the list (no ghost) and does not re-create the room", async () => {
  // Sanity: the conversation is live and resolvable before the delete.
  expect(await runtime.resolveConversationStore(convId)).not.toBeNull();

  await runtime.getWorkspaceStore().delete(wsId);

  // The locator invalidated (via the membership-change hook), so a rebuild no
  // longer lists the archived room's conversation.
  const list = await runtime.listConversations({}, { userId: ALICE.id });
  expect(list.conversations.find((c) => c.id === convId)).toBeUndefined();

  // resolveConversationStore returns null instead of constructing a store at the
  // archived path (whose constructor would mkdir it back into existence).
  expect(await runtime.resolveConversationStore(convId)).toBeNull();

  // The room's conversation dir was NOT re-created under workspaces/.
  expect(existsSync(roomConversationsDir(workDir, wsId, ALICE.id))).toBe(false);
});
