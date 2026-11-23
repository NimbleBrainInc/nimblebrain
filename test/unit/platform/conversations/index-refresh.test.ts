/**
 * The conversations-tool index must stay fresh in the workspace layout, where a
 * root `fs.watch` can't see nested writes. Freshness comes from `invalidate()` +
 * `refresh()`: a change that names its conversation costs one header re-read,
 * and only an unattributed change rebuilds the whole index.
 *
 * Two groups of failure mode are pinned here. The first is staleness the read
 * path must not serve — frozen summaries on update, ghosts on delete. The
 * second is what the named signal costs: a write that does not announce itself
 * is never repaired, because no unrelated traffic will name that conversation
 * again. `conversations__update` writes its file outside the store, so it is
 * the case that group exists for, and those tests use targeted refreshes only — a bare `invalidate()` would rebuild
 * everything and mask exactly the defect under test.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceConversationsDir } from "../../../../src/conversation/paths.ts";
import { ConversationIndex } from "../../../../src/platform/conversations/index-cache.ts";
import { handleUpdate } from "../../../../src/platform/conversations/tools/update.ts";

let workDir: string;
const WS = "ws_003eba8844413cd9";
const OWNER = "usr_alice";
const SCOPE = { workspaceId: WS, userId: OWNER };
const CONV = "conv_00000000000000a1";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-connector-index-"));
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
    model: "anthropic:claude-sonnet-4-6",
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
  expect(index.list(SCOPE).conversations[0]?.messageCount).toBe(0);

  // Append a user message (changes the derived summary).
  appendFileSync(
    file,
    `${JSON.stringify({ ts: "2026-06-25T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] })}\n`,
  );

  // Clean cache → refresh is a no-op → still stale (this is the bug if relied on alone).
  await index.refresh();
  expect(index.list(SCOPE).conversations[0]?.messageCount).toBe(0);

  // The runtime's change hook flags it stale → refresh rebuilds → fresh.
  index.invalidate();
  await index.refresh();
  expect(index.list(SCOPE).conversations[0]?.messageCount).toBe(1);
});

test("a delete drops the entry on invalidate()+refresh() (no ghost)", async () => {
  const file = convFile();
  seed(file);

  const index = new ConversationIndex();
  await index.build(workspacesRoot());
  expect(index.list(SCOPE).totalCount).toBe(1);

  rmSync(file);

  // Clean cache still shows the ghost...
  await index.refresh();
  expect(index.list(SCOPE).totalCount).toBe(1);

  // ...invalidate + rebuild drops the vanished file.
  index.invalidate();
  await index.refresh();
  expect(index.list(SCOPE).totalCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Writers outside the store
// ---------------------------------------------------------------------------

/**
 * `conversations__update` writes the conversation file itself rather than
 * going through `EventSourcedConversationStore`, so the store's `onMutate`
 * never fires for it. Now that the index refreshes only
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
  expect(index.get(CONV, SCOPE)!.title).toBeNull();

  await handleUpdate({ id: CONV, title: "Renamed by the tool" }, index, SCOPE);
  await index.refresh();

  expect(index.get(CONV, SCOPE)!.title).toBe("Renamed by the tool");
  // The handler supplies the wsId, so the announcement is also what keeps the
  // entry inside its workspace wall.
  expect(index.get(CONV, SCOPE)!.workspaceId).toBe(WS);
});

test("a targeted refresh keeps the entry's workspace binding", async () => {
  const file = convFile();
  seed(file);

  const index = new ConversationIndex();
  await index.build(workspacesRoot());
  expect(index.get(CONV, SCOPE)!.workspaceId).toBe(WS);

  // The incremental path derives workspaceId from the change rather than from a
  // directory walk. If it dropped that, the entry would fall out of every
  // workspace-scoped read while still being present in the map.
  index.invalidate({ id: CONV, filePath: file, wsId: WS });
  await index.refresh();

  expect(index.get(CONV, SCOPE)!.workspaceId).toBe(WS);
  expect(index.list(SCOPE).totalCount).toBe(1);
});
