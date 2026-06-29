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
