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

test("a second joiner waits for the rebuild the first joiner started", async () => {
  // Joining the in-flight rebuild has to be a loop, not a single await. Two
  // readers join rebuild P1; a write lands mid-P1, so both find the index dirty
  // when P1 resolves. The first starts P2 and clears the flag — and a second
  // reader that awaited only P1 would then fall straight through the clean
  // check and answer against the map P2 has already emptied.
  for (let i = 0; i < 300; i++) writeConv(`conv_${String(i).padStart(3, "0")}`);
  const index = new ConversationIndex();
  await index.build(dir);

  index.invalidate();
  const p1 = index.refresh();

  // Both joiners arrive while P1 is in flight.
  const joinerA = index.refresh();
  const joinerB = index.refresh().then(() => index.size);

  // A write lands mid-P1, so P1's result is already stale when it resolves.
  writeConv("conv_late");
  index.invalidate();

  const [, , observedByB] = await Promise.all([p1, joinerA, joinerB]);
  expect(observedByB).toBeGreaterThan(0);
});

test("refresh() returns while writes are still arriving", async () => {
  // The invalidation hook fires on every appended event line, tenant-wide, so
  // "no write landed anywhere during a full rebuild" is not a condition a busy
  // tenant reaches. A refresh that retries until it observes a clean index
  // therefore does not return under sustained writes — it must settle for an
  // index as fresh as its own entry, not the latest one.
  for (let i = 0; i < 150; i++) writeConv(`conv_${String(i).padStart(3, "0")}`);
  const index = new ConversationIndex();
  await index.build(dir);

  const ticker = setInterval(() => index.invalidate(), 1);
  index.invalidate();
  try {
    const outcome = await Promise.race([
      index.refresh().then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(outcome).toBe("returned");
  } finally {
    clearInterval(ticker);
  }
});

test("a reader arriving mid-rebuild waits for it instead of reading the cleared map", async () => {
  // `build()` clears the map before repopulating it, so the dangerous reader is
  // the one that arrives when `dirty` is ALREADY false — cleared by the rebuild
  // now in flight. It must join that rebuild, not conclude "clean, nothing to
  // do" and answer against a half-empty index. This is why the in-flight check
  // has to precede the dirty check.
  for (let i = 0; i < 300; i++) writeConv(`conv_${String(i).padStart(3, "0")}`);
  const index = new ConversationIndex();
  await index.build(dir);
  expect(index.size).toBe(300);

  index.invalidate();
  const rebuild = index.refresh();
  // `dirty` is false from here on — the rebuild owns it.
  const midReader = index.refresh().then(() => index.size);

  const [, observed] = await Promise.all([rebuild, midReader]);
  expect(observed).toBe(300);
});

test("a reader that joins an in-flight rebuild does not inherit its stale result", async () => {
  writeConv("conv_one");
  const index = new ConversationIndex();
  await index.build(dir);

  index.invalidate();
  const first = index.refresh();

  // A write lands after `build()` listed the directory, so the in-flight
  // rebuild cannot contain it. A second reader arriving now must NOT be handed
  // that rebuild's result — it has to re-decide once the rebuild finishes.
  writeConv("conv_two");
  index.invalidate();
  const joiner = index.refresh();

  await Promise.all([first, joiner]);
  expect(index.size).toBe(2);
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
