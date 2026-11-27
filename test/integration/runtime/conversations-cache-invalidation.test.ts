/**
 * Conversation list views must follow every write AND a workspace delete —
 * otherwise they freeze on update / ghost on delete. Deleting a workspace
 * purges its conversations through the conversations plugin
 * (`delete_workspace`), and nothing reads them back into existence.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRequestContext } from "../../../src/runtime/request-context.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { ownerConversationsDir } from "../../helpers/conversation-store.ts";
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

test("a workspace purge clears its conversations from the list (no ghost) and does not re-create the workspace", async () => {
  // Sanity: the conversation is live and resolvable before the delete.
  expect(await runtime.resolveConversationStore(wsId, convId, ALICE.id)).not.toBeNull();

  const result = await runWithRequestContext({ identity: ALICE, workspaceId: wsId }, () =>
    runtime.deleteWorkspace(wsId),
  );
  expect(result.deleted).toBe(true);
  expect((await runtime.purgeWorkspace(wsId)).purged).toBe(true);

  // The purged workspace's conversation is no longer listed.
  const list = await runtime.listConversations(wsId, {}, { userId: ALICE.id });
  expect(list.conversations.find((c) => c.id === convId)).toBeUndefined();

  expect(await runtime.resolveConversationStore(wsId, convId, ALICE.id)).toBeNull();

  // The plugin's storage for the workspace is gone, and no read made it again.
  expect(existsSync(ownerConversationsDir(workDir, wsId, ALICE.id))).toBe(false);
});
