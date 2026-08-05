/**
 * `invalidate()` arriving mid-rebuild must not be lost.
 *
 * `refresh()` clears the dirty flag AFTER `build()` resolves, so an
 * invalidation that lands while a rebuild is in flight is cleared by a rebuild
 * that never saw the write. The write is then absent from list / search / stats
 * until an unrelated later write re-dirties the index.
 *
 * This is reachable on its own, but the platform source's refresh coalescing
 * is what makes it bite every concurrent reader: a second caller that used to
 * enter `refresh()`, see `dirty === true` and rebuild now piggybacks on the
 * in-flight rebuild and inherits its stale result.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationIndex } from "../../../../src/bundles/conversations/src/index-cache.ts";

let dir: string;

function writeConv(id: string): void {
  const meta = {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    lastModel: null,
    ownerId: "usr_test",
  };
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify(meta)}\n${JSON.stringify({ role: "user", content: "hi" })}\n`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-idx-lost-"));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("an invalidate() during an in-flight rebuild is not swallowed by that rebuild", async () => {
  writeConv("conv_one");
  const index = new ConversationIndex();
  await index.build(dir);
  expect(index.size).toBe(1);

  // A write lands, so the index goes stale and a read starts rebuilding.
  index.invalidate();
  const inflight = index.refresh();

  // A second write lands WHILE that rebuild is in flight. `build()` has already
  // listed the directory, so this rebuild cannot include it — but the
  // invalidation it raises must survive for the next read to act on.
  writeConv("conv_two");
  index.invalidate();

  await inflight;
  await index.refresh();

  expect(index.size).toBe(2);
});
