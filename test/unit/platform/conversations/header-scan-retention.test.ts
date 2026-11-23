/**
 * The index keeps one header scan per conversation for the life of the process,
 * so a scan must hold only what it needs. A scan that keeps a view of the file
 * it read, or a slice of the file's decoded text (which JavaScriptCore stores
 * as a view of the whole string), pins every conversation file in memory.
 *
 * Kept in its own file: it measures the process heap, and other suites' objects
 * in the same `bun test` process would add noise.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceConversationsDir } from "../../../../src/conversation/paths.ts";
import { ConversationIndex } from "../../../../src/platform/conversations/index-cache.ts";

const WS = "ws_00000000000000c1";
const OWNER = "usr_alice";
const FILES = 64;
const FILE_BYTES = 256 * 1024;

let workDir: string;
let inputBytes = 0;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-header-retention-"));
  const dir = workspaceConversationsDir(workDir, WS, OWNER);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < FILES; i++) {
    const id = `conv_${i.toString(16).padStart(16, "0")}`;
    const lines = [
      JSON.stringify({
        id,
        createdAt: "2026-06-01T00:00:00.000Z",
        model: "model-0",
        ownerId: OWNER,
        workspaceId: WS,
        format: "events",
      }),
    ];
    let n = 0;
    // "€" is outside Latin-1, so JavaScriptCore stores the decoded text at two
    // bytes per character: the case that doubled production's retention.
    while (lines.join("\n").length < FILE_BYTES) {
      lines.push(
        JSON.stringify({
          ts: "2026-06-01T00:00:01.000Z",
          type: "user.message",
          content: [{ type: "text", text: `€ question ${n++} ${"x".repeat(4096)}` }],
        }),
      );
    }
    const text = `${lines.join("\n")}\n`;
    inputBytes += Buffer.byteLength(text);
    writeFileSync(join(dir, `${id}.jsonl`), text);
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function heapAfterGc(): number {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

test("test_build_index_retains_far_less_than_the_files_it_read", async () => {
  const before = heapAfterGc();
  const index = new ConversationIndex();
  await index.build(join(workDir, "workspaces"));
  const grown = heapAfterGc() - before;

  // Hold the index past the measurement, and prove it indexed every file, so
  // the test cannot pass by measuring an index that was collected or empty.
  expect(index.list({}, { userId: OWNER }).totalCount).toBe(FILES);
  expect(grown).toBeLessThan(inputBytes * 0.25);
});
