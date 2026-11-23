/**
 * Conversation list views must follow every write AND a workspace
 * archive-delete — otherwise they freeze on update / ghost on delete, and a
 * read could re-create a deleted workspace's directory.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceConversationsDir } from "../../../src/conversation/paths.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { makeIdentity } from "../../helpers/identity.ts";

const ALICE = makeIdentity({ id: "usr_alice", email: "alice@example.com" });
const workDir = join(tmpdir(), `nb-conv-cache-${Date.now()}`);

let runtime: Runtime;
let wsId: string;
let convId: string;

beforeAll(async () => {
  mkdirSync(workDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
  const wsStore = runtime.getWorkspaceStore();
  const ws = await wsStore.create("Helix");
  wsId = ws.id;
  await wsStore.addMember(wsId, ALICE.id, "admin");
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true });
});

test("an append refreshes the listed summary (list is not frozen)", async () => {
  const r = await runtime.chat({ message: "first", workspaceId: wsId, identity: ALICE });
  convId = r.conversationId;

  let list = await runtime.listConversations(wsId, {}, { userId: ALICE.id });
  expect(list.totalCount).toBe(1);
  const afterTurn1 = list.conversations[0]?.messageCount ?? 0;

  // Resume — a second turn appends to the same file via the workspace store.
  await runtime.chat({
    message: "second",
    conversationId: convId,
    workspaceId: wsId,
    identity: ALICE,
  });

  list = await runtime.listConversations(wsId, {}, { userId: ALICE.id });
  expect(list.totalCount).toBe(1);
  // The summary advanced — the list re-read the file rather than serving a
  // frozen entry.
  expect(list.conversations[0]?.messageCount ?? 0).toBeGreaterThan(afterTurn1);
});

test("workspace delete clears its conversations from the list (no ghost) and does not re-create the workspace", async () => {
  // Sanity: the conversation is live and resolvable before the delete.
  expect(await runtime.resolveConversationStore(wsId, convId, ALICE.id)).not.toBeNull();

  await runtime.getWorkspaceStore().delete(wsId);

  // The archived workspace's conversation is no longer listed.
  const list = await runtime.listConversations(wsId, {}, { userId: ALICE.id });
  expect(list.conversations.find((c) => c.id === convId)).toBeUndefined();

  // resolveConversationStore returns null instead of constructing a store at the
  // archived path (whose constructor would mkdir it back into existence).
  expect(await runtime.resolveConversationStore(wsId, convId, ALICE.id)).toBeNull();

  // The workspace's conversation dir was NOT re-created under workspaces/.
  expect(existsSync(workspaceConversationsDir(workDir, wsId, ALICE.id))).toBe(false);
});
