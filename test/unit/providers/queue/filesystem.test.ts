import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemWorkQueue,
  itemFileName,
  LOCK_FILE,
} from "../../../../src/providers/queue/filesystem.ts";
import { WORK_QUEUE_RETENTION_MS, type WorkQueue } from "../../../../src/providers/queue/types.ts";
import {
  createTestClock,
  describeWorkQueueConformance,
  type TestClock,
} from "../../../helpers/work-queue-conformance.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nb-work-queue-"));
}

describeWorkQueueConformance("filesystem", async (clock) => {
  const dir = tempDir();
  const queue = createFilesystemWorkQueue({ dir, now: clock.now });
  return {
    queue,
    cleanup: async () => {
      await queue.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe("filesystem work queue", () => {
  const dirs: string[] = [];
  const open: WorkQueue[] = [];

  function fresh(clock: TestClock = createTestClock(), dir = tempDir()) {
    if (!dirs.includes(dir)) dirs.push(dir);
    const queue = createFilesystemWorkQueue({ dir, now: clock.now });
    open.push(queue);
    return { queue, dir, clock };
  }

  afterEach(async () => {
    for (const q of open.splice(0)) await q.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("serves one process", () => {
    expect(fresh().queue.multiProcess).toBe(false);
  });

  test("stores one JSON file per item, named by the hash of its key", async () => {
    const { queue, dir } = fresh();
    await queue.enqueue({ kind: "k", payload: { a: 1 }, idempotencyKey: "key-1" });
    await queue.enqueue({ kind: "k", payload: { a: 2 }, idempotencyKey: "key-2" });
    const files = readdirSync(dir)
      .filter((f) => f !== LOCK_FILE)
      .sort();
    expect(files).toEqual([itemFileName("key-1"), itemFileName("key-2")].sort());
    const stored = JSON.parse(readFileSync(join(dir, itemFileName("key-1")), "utf-8"));
    expect(stored).toMatchObject({ idempotencyKey: "key-1", kind: "k", payload: { a: 1 } });
  });

  test("leaves no temp file after a write", async () => {
    const { queue, dir } = fresh();
    await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" });
    const claim = await queue.claim({ workerId: "w", leaseMs: 1_000 });
    if (!claim) throw new Error("expected a claim");
    await queue.extend(claim, 1_000);
    await queue.complete(claim);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  describe("crash safety", () => {
    test("a half-written temp file is never read as an item, and is removed at open", async () => {
      const dir = tempDir();
      const name = itemFileName("a");
      writeFileSync(join(dir, `${name}.123.1.tmp`), '{"id":"half-writ');
      const { queue } = fresh(createTestClock(), dir);
      expect(await queue.claim({ workerId: "w", leaseMs: 1_000 })).toBeNull();
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect((await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "a" })).created).toBe(
        true,
      );
    });

    test("a half-written temp file beside an item leaves the item as it was", async () => {
      const clock = createTestClock();
      const dir = tempDir();
      const first = fresh(clock, dir);
      const { id } = await first.queue.enqueue({ kind: "k", payload: "v", idempotencyKey: "a" });
      await first.queue.close();
      // A crash mid-way through a state change: the temp file was never renamed.
      writeFileSync(join(dir, `${itemFileName("a")}.999.7.tmp`), '{"state":"comp');
      const { queue } = fresh(clock, dir);
      const claim = await queue.claim({ workerId: "w", leaseMs: 1_000 });
      expect(claim?.id).toBe(id);
      expect(claim?.payload).toBe("v");
      expect(claim?.attempt).toBe(1);
    });

    test("state survives a reopen: a claim stays held, its token fences, and enqueue order holds", async () => {
      const clock = createTestClock();
      const dir = tempDir();
      const first = fresh(clock, dir);
      await first.queue.enqueue({ kind: "k", payload: "one", idempotencyKey: "a" });
      await first.queue.enqueue({ kind: "k", payload: "two", idempotencyKey: "b" });
      const held = await first.queue.claim({ workerId: "w", leaseMs: 10_000 });
      if (!held) throw new Error("expected a claim");
      await first.queue.close();

      const { queue } = fresh(clock, dir);
      await queue.enqueue({ kind: "k", payload: "three", idempotencyKey: "c" });
      expect((await queue.claim({ workerId: "w", leaseMs: 10_000 }))?.payload).toBe("two");
      expect((await queue.claim({ workerId: "w", leaseMs: 10_000 }))?.payload).toBe("three");
      await queue.extend(held, 10_000);
      await queue.complete(held);
    });
  });

  describe("the lock", () => {
    test("refuses a second instance on the same directory", () => {
      const { dir } = fresh();
      expect(() => createFilesystemWorkQueue({ dir })).toThrow(/already open/);
    });

    test("refuses while another live process holds the directory", () => {
      const dir = tempDir();
      dirs.push(dir);
      // The parent of this test process is alive and is not this process.
      writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: process.ppid }));
      expect(() => createFilesystemWorkQueue({ dir })).toThrow(/held by process/);
    });

    test("is released by close, so the directory opens again", async () => {
      const { queue, dir } = fresh();
      await queue.close();
      expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
      expect(() => fresh(createTestClock(), dir)).not.toThrow();
    });

    test("left by a process that is gone, is taken over", () => {
      const dir = tempDir();
      // Above the highest pid any supported kernel hands out.
      writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 2 ** 30 }));
      fresh(createTestClock(), dir);
      const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf-8"));
      expect(lock.pid).toBe(process.pid);
    });
  });

  describe("retention", () => {
    test("a terminal item is swept by the first claim after its window", async () => {
      const { queue, dir, clock } = fresh();
      await queue.enqueue({ kind: "k", payload: 1, idempotencyKey: "done" });
      await queue.enqueue({ kind: "k", payload: 2, idempotencyKey: "failed" });
      await queue.enqueue({ kind: "k", payload: 3, idempotencyKey: "waiting" });
      const a = await queue.claim({ workerId: "w", leaseMs: 1_000 });
      const b = await queue.claim({ workerId: "w", leaseMs: 1_000 });
      if (!a || !b) throw new Error("expected two claims");
      await queue.complete(a);
      await queue.fail(b, { error: "permanent" });

      clock.advance(WORK_QUEUE_RETENTION_MS - 1);
      await queue.claim({ workerId: "w", leaseMs: 1_000, kinds: [] });
      expect(existsSync(join(dir, itemFileName("done")))).toBe(true);

      clock.advance(1);
      await queue.claim({ workerId: "w", leaseMs: 1_000, kinds: [] });
      expect(existsSync(join(dir, itemFileName("done")))).toBe(false);
      expect(existsSync(join(dir, itemFileName("failed")))).toBe(false);
      // Not terminal, so kept however old.
      expect(existsSync(join(dir, itemFileName("waiting")))).toBe(true);
    });

    test("after the window, the key enqueues a new item, swept or not", async () => {
      const { queue, clock } = fresh();
      const old = await queue.enqueue({ kind: "k", payload: "old", idempotencyKey: "a" });
      const claim = await queue.claim({ workerId: "w", leaseMs: 1_000 });
      if (!claim) throw new Error("expected a claim");
      await queue.complete(claim);
      clock.advance(WORK_QUEUE_RETENTION_MS);
      const again = await queue.enqueue({ kind: "k", payload: "new", idempotencyKey: "a" });
      expect(again.created).toBe(true);
      expect(again.id).not.toBe(old.id);
      const next = await queue.claim({ workerId: "w", leaseMs: 1_000 });
      expect(next?.payload).toBe("new");
      expect(next?.attempt).toBe(1);
      // The old item's claim cannot touch the new item.
      await expect(queue.complete(claim)).rejects.toThrow(/no longer current/);
    });
  });
});
