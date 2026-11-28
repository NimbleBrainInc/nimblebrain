import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemWorkQueue,
  itemFileName,
  LOCK_FILE,
} from "../../../../src/providers/queue/filesystem.ts";
import {
  type EnqueueRequest,
  WORK_QUEUE_RETENTION_MS,
  type WorkQueue,
} from "../../../../src/providers/queue/types.ts";
import {
  createTestClock,
  describeWorkQueueConformance,
  type TestClock,
} from "../../../helpers/work-queue-conformance.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nb-work-queue-"));
}

// Durable, and one process per directory: the peer cases are skipped.
describeWorkQueueConformance(
  "filesystem",
  async () => {
    const dir = tempDir();
    const clock = createTestClock();
    const opened = [createFilesystemWorkQueue({ dir, now: clock.now })];
    const queue = opened[0] as WorkQueue;
    return {
      queue,
      clock,
      reopen: async () => {
        for (const q of opened) await q.close();
        const again = createFilesystemWorkQueue({ dir, now: clock.now });
        opened.push(again);
        return again;
      },
      cleanup: async () => {
        for (const q of opened) await q.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
  { durable: true },
);

const SCOPE = "ws-test-a";
const W = { workerId: "w", leaseMs: 1_000, kinds: ["k"] };

function item(key: string, payload: unknown = key, scope = SCOPE): EnqueueRequest {
  return { scope, kind: "k", payload, idempotencyKey: key };
}

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

  test("stores one JSON file per item, named by the hash of its scope and key", async () => {
    const { queue, dir } = fresh();
    await queue.enqueue(item("key-1", { a: 1 }));
    await queue.enqueue(item("key-2", { a: 2 }));
    const files = readdirSync(dir)
      .filter((f) => f !== LOCK_FILE)
      .sort();
    expect(files).toEqual([itemFileName(SCOPE, "key-1"), itemFileName(SCOPE, "key-2")].sort());
    const stored = JSON.parse(readFileSync(join(dir, itemFileName(SCOPE, "key-1")), "utf-8"));
    expect(stored).toMatchObject({ idempotencyKey: "key-1", kind: "k", payload: { a: 1 } });
  });

  test("separates scope from key, so no join of the two collides", async () => {
    const { queue } = fresh();
    const a = await queue.enqueue(item("b:c", 1, "a"));
    const b = await queue.enqueue(item("c", 1, "a:b"));
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(itemFileName("a", "b:c")).not.toBe(itemFileName("a:b", "c"));
  });

  test("leaves no temp file after a write", async () => {
    const { queue, dir } = fresh();
    await queue.enqueue(item("a", 1));
    const claim = await queue.claim(W);
    if (!claim) throw new Error("expected a claim");
    await queue.extend(claim, 1_000);
    await queue.complete(claim);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  describe("crash safety", () => {
    test("a half-written temp file is never read as an item, and is removed at open", async () => {
      const dir = tempDir();
      const name = itemFileName(SCOPE, "a");
      writeFileSync(join(dir, `${name}.123.1.tmp`), '{"id":"half-writ');
      const { queue } = fresh(createTestClock(), dir);
      expect(await queue.claim(W)).toBeNull();
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect((await queue.enqueue(item("a", 1))).created).toBe(true);
    });

    test("a half-written temp file beside an item leaves the item as it was", async () => {
      const clock = createTestClock();
      const dir = tempDir();
      const first = fresh(clock, dir);
      const { id } = await first.queue.enqueue(item("a", "v"));
      await first.queue.close();
      // A crash mid-way through a state change: the temp file was never renamed.
      writeFileSync(join(dir, `${itemFileName(SCOPE, "a")}.999.7.tmp`), '{"state":"comp');
      const { queue } = fresh(clock, dir);
      const claim = await queue.claim(W);
      expect(claim?.id).toBe(id);
      expect(claim?.payload).toBe("v");
      expect(claim?.attempt).toBe(1);
    });

    test("enqueue order breaks ties across a reopen", async () => {
      const clock = createTestClock();
      const dir = tempDir();
      const first = fresh(clock, dir);
      await first.queue.enqueue(item("a", "one"));
      await first.queue.enqueue(item("b", "two"));
      const done = await first.queue.claim(W);
      if (!done) throw new Error("expected a claim");
      await first.queue.complete(done);
      await first.queue.close();

      const { queue } = fresh(clock, dir);
      await queue.enqueue(item("c", "three"));
      expect((await queue.claim(W))?.payload).toBe("two");
      expect((await queue.claim(W))?.payload).toBe("three");
    });

    test("a claim held when the queue opens is due at once, and its next claim supersedes it", async () => {
      const clock = createTestClock();
      const dir = tempDir();
      const first = fresh(clock, dir);
      await first.queue.enqueue(item("a", "running"));
      const held = await first.queue.claim({ ...W, leaseMs: 60_000 });
      if (!held) throw new Error("expected a claim");
      // The process stops without settling; the next one opens a moment later.
      await first.queue.close();
      clock.advance(1_000);

      const { queue } = fresh(clock, dir);
      const again = await queue.claim(W);
      expect([again?.id, again?.attempt, again?.token]).toEqual([held.id, 2, held.token + 1]);
      await expect(queue.extend(held, 1_000)).rejects.toMatchObject({ reason: "superseded" });
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
      await queue.enqueue(item("done", 1));
      await queue.enqueue(item("failed", 2));
      await queue.enqueue(item("waiting", 3));
      const a = await queue.claim(W);
      const b = await queue.claim(W);
      if (!a || !b) throw new Error("expected two claims");
      await queue.complete(a);
      await queue.fail(b, { error: "permanent" });

      clock.advance(WORK_QUEUE_RETENTION_MS - 1);
      await queue.claim({ ...W, kinds: ["none"] });
      expect(existsSync(join(dir, itemFileName(SCOPE, "done")))).toBe(true);

      clock.advance(1);
      await queue.claim({ ...W, kinds: ["none"] });
      expect(existsSync(join(dir, itemFileName(SCOPE, "done")))).toBe(false);
      expect(existsSync(join(dir, itemFileName(SCOPE, "failed")))).toBe(false);
      // Not terminal, so kept however old.
      expect(existsSync(join(dir, itemFileName(SCOPE, "waiting")))).toBe(true);
    });

    test("after the window, the key enqueues a new item, swept or not", async () => {
      const { queue, clock } = fresh();
      const old = await queue.enqueue(item("a", "old"));
      const claim = await queue.claim(W);
      if (!claim) throw new Error("expected a claim");
      await queue.complete(claim);
      clock.advance(WORK_QUEUE_RETENTION_MS);
      const again = await queue.enqueue(item("a", "new"));
      expect(again.created).toBe(true);
      expect(again.id).not.toBe(old.id);
      const next = await queue.claim(W);
      expect(next?.payload).toBe("new");
      expect(next?.attempt).toBe(1);
      // The old item's claim cannot touch the new item.
      await expect(queue.complete(claim)).rejects.toThrow(/gone/);
    });
  });
});
