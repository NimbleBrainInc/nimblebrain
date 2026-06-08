import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationIndex } from "../../src/bundles/conversations/src/index-cache.ts";

// flushPending() must surface a brand-new conversation deterministically —
// the conversations-list refresh fires the instant a turn starts, before the
// fs.watch debounce re-indexes the new file (the "new conversation doesn't
// show up" bug).

function writeConversation(dir: string, id: string): void {
  const meta = JSON.stringify({
    id,
    ownerId: "usr_test",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    title: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastModel: null,
  });
  const userMsg = JSON.stringify({ role: "user", content: "Hello", timestamp: "2025-01-01T00:00:00.000Z" });
  writeFileSync(join(dir, `${id}.jsonl`), `${meta}\n${userMsg}\n`);
}

describe("ConversationIndex.flushPending", () => {
  let dir: string;
  let index: ConversationIndex;

  beforeEach(async () => {
    dir = join(tmpdir(), `nb-flush-test-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    index = new ConversationIndex();
    await index.build(dir);
  });

  afterEach(() => {
    index.stopWatching();
    rmSync(dir, { recursive: true, force: true });
  });

  it("picks up a newly written conversation file without waiting for the watch debounce", async () => {
    expect(index.list().totalCount).toBe(0);

    // A new conversation lands on disk (as runtime.startTurn's store.create does).
    writeConversation(dir, "conv_brandnew000001");
    // Without flushing, the in-memory index hasn't seen it yet.
    expect(index.list().totalCount).toBe(0);

    await index.flushPending();
    const result = index.list();
    expect(result.totalCount).toBe(1);
    expect(result.conversations[0].id).toBe("conv_brandnew000001");
  });
});
