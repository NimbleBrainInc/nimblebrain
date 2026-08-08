/**
 * The conversations-tool index must stay fresh in the workspace layout, where a root
 * `fs.watch` can't see nested writes. Freshness comes from `invalidate()` +
 * `refresh()` (a full rebuild), NOT the watcher. This pins the two failure modes
 * the watcher/add-only-rescan left open: frozen summaries on update, ghosts on
 * delete.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationIndex } from "../../../../src/bundles/conversations/src/index-cache.ts";
import { handleFork } from "../../../../src/bundles/conversations/src/tools/fork.ts";
import { handleUpdate } from "../../../../src/bundles/conversations/src/tools/update.ts";
import { workspaceConversationsDir } from "../../../../src/conversation/paths.ts";

let workDir: string;
const WS = "ws_helix";
const OWNER = "usr_alice";
const CONV = "conv_00000000000000a1";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-bundle-index-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function convFile(): string {
  const dir = workspaceConversationsDir(workDir, WS, OWNER);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${CONV}.jsonl`);
}

function seed(file: string): void {
  const meta = {
    id: CONV,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    title: null,
    ownerId: OWNER,
    workspaceId: WS,
    format: "events",
  };
  writeFileSync(file, `${JSON.stringify(meta)}\n`);
}

function workspacesRoot(): string {
  return join(workDir, "workspaces");
}

test("an update is invisible until invalidate()+refresh() (no frozen summary)", async () => {
  const file = convFile();
  seed(file);

  const index = new ConversationIndex();
  await index.build(workspacesRoot());
  expect(index.list().conversations[0]?.messageCount).toBe(0);

  // Append a user message (changes the derived summary).
  appendFileSync(
    file,
    `${JSON.stringify({ ts: "2026-06-25T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] })}\n`,
  );

  // Clean cache → refresh is a no-op → still stale (this is the bug if relied on alone).
  await index.refresh();
  expect(index.list().conversations[0]?.messageCount).toBe(0);

  // The runtime's change hook flags it stale → refresh rebuilds → fresh.
  index.invalidate();
  await index.refresh();
  expect(index.list().conversations[0]?.messageCount).toBe(1);
});

test("a delete drops the entry on invalidate()+refresh() (no ghost)", async () => {
  const file = convFile();
  seed(file);

  const index = new ConversationIndex();
  await index.build(workspacesRoot());
  expect(index.list().totalCount).toBe(1);

  rmSync(file);

  // Clean cache still shows the ghost...
  await index.refresh();
  expect(index.list().totalCount).toBe(1);

  // ...invalidate + rebuild drops the vanished file.
  index.invalidate();
  await index.refresh();
  expect(index.list().totalCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Writers outside the store
// ---------------------------------------------------------------------------

/**
 * `conversations__update` and `conversations__fork` write conversation files
 * themselves rather than going through `EventSourcedConversationStore`, so the
 * store's `onMutate` never fires for them. Now that the index refreshes only
 * what a change names, an unannounced write is never repaired — no unrelated
 * traffic will name that conversation again.
 *
 * These tests deliberately use ONLY targeted refreshes. A bare `invalidate()`
 * anywhere would rebuild everything and mask the defect.
 */

test("handleUpdate's write is announced, so the rename lands on a targeted refresh", async () => {
  const file = convFile();
  seed(file);

  const index = new ConversationIndex();
  await index.build(workspacesRoot());
  expect(index.get(CONV)!.title).toBeNull();

  await handleUpdate({ id: CONV, title: "Renamed by the tool" }, index);
  await index.refresh();

  expect(index.get(CONV)!.title).toBe("Renamed by the tool");
});

test("handleFork's new conversation is announced, so it appears on a targeted refresh", async () => {
  const file = convFile();
  seed(file);
  appendFileSync(
    file,
    `${JSON.stringify({ ts: "2026-06-25T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] })}\n`,
  );

  const index = new ConversationIndex();
  await index.build(workspacesRoot());
  expect(index.list().totalCount).toBe(1);

  const forked = (await handleFork({ id: CONV }, index)) as { id: string };
  await index.refresh();

  // Absent, not merely stale: the index has never seen this conversation, so
  // nothing but its own announcement can introduce it.
  expect(index.get(forked.id)).toBeDefined();
  expect(index.list().totalCount).toBe(2);
});

test("a targeted refresh keeps the entry's workspace binding", async () => {
  const file = convFile();
  seed(file);

  const index = new ConversationIndex();
  await index.build(workspacesRoot());
  expect(index.get(CONV)!.workspaceId).toBe(WS);

  // The incremental path derives workspaceId from the change rather than from a
  // directory walk. If it dropped that, the entry would fall out of every
  // workspace-scoped read while still being present in the map.
  index.invalidate({ id: CONV, filePath: file, wsId: WS });
  await index.refresh();

  expect(index.get(CONV)!.workspaceId).toBe(WS);
  expect(index.list({ workspaceId: WS }).totalCount).toBe(1);
});
