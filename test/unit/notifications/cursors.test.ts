/**
 * The cursor lives on the workspace record beside `hooks` and takes the same
 * lock. Two properties matter here and nowhere else:
 *
 *   - a cursor write and a hooks write cannot lose each other, because
 *     `WorkspaceStore.update` patches a snapshot it read itself; and
 *   - uninstalling a connector drops its position, so a reinstall bootstraps.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateRegistrations } from "../../../src/hooks/registrations.ts";
import { clearCursor, readCursor, writeCursor } from "../../../src/notifications/cursors.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

let workDir: string;
let store: WorkspaceStore;
let wsId: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-notify-cursors-"));
  store = new WorkspaceStore(workDir);
  wsId = (await store.create("Cursors")).id;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function record() {
  const ws = await store.get(wsId);
  if (!ws) throw new Error("workspace vanished");
  return ws;
}

describe("readCursor", () => {
  test("is undefined until something is written — the bootstrap", async () => {
    expect(readCursor(await record(), "acme")).toBeUndefined();
  });

  test("ignores a stored value that is not a non-empty string", async () => {
    await store.update(wsId, { notifications: { cursors: { acme: "" } } });
    expect(readCursor(await record(), "acme")).toBeUndefined();
  });
});

describe("writeCursor", () => {
  test("stores per connector", async () => {
    await writeCursor(store, wsId, "acme", "cur_1");
    await writeCursor(store, wsId, "other", "cur_2");
    const ws = await record();
    expect(readCursor(ws, "acme")).toBe("cur_1");
    expect(readCursor(ws, "other")).toBe("cur_2");
  });

  test("re-writing the same value costs no write", async () => {
    await writeCursor(store, wsId, "acme", "cur_1");
    const first = (await record()).updatedAt;
    await Bun.sleep(2);
    await writeCursor(store, wsId, "acme", "cur_1");
    expect((await record()).updatedAt).toBe(first);
  });

  test("concurrent cursor writes do not lose each other", async () => {
    await Promise.all([
      writeCursor(store, wsId, "a", "cur_a"),
      writeCursor(store, wsId, "b", "cur_b"),
      writeCursor(store, wsId, "c", "cur_c"),
    ]);
    const ws = await record();
    expect([readCursor(ws, "a"), readCursor(ws, "b"), readCursor(ws, "c")]).toEqual([
      "cur_a",
      "cur_b",
      "cur_c",
    ]);
  });

  test("a cursor write and a hooks write do not clobber each other", async () => {
    // The whole reason both take ONE chain per workspace rather than one each:
    // `update` replaces the fields it is given on a record it read itself, so a
    // cursor write that did not queue behind a hooks write would restore the
    // hooks map as it stood before it.
    await Promise.all([
      writeCursor(store, wsId, "acme", "cur_1"),
      updateRegistrations(store, wsId, (current) => {
        current["acme/vendor"] = {
          connector: "acme",
          vendor: "vendor",
          kid: "kid_1",
          deliveryId: "did_1",
          createdAt: new Date().toISOString(),
          route: "ingest",
        };
        return current;
      }),
    ]);

    const ws = await record();
    expect(readCursor(ws, "acme")).toBe("cur_1");
    expect(ws.hooks?.["acme/vendor"]?.kid).toBe("kid_1");
  });
});

describe("clearCursor", () => {
  test("drops one connector's position and leaves the rest", async () => {
    await writeCursor(store, wsId, "acme", "cur_1");
    await writeCursor(store, wsId, "other", "cur_2");

    expect(await clearCursor(store, wsId, "acme")).toBe(true);

    const ws = await record();
    expect(readCursor(ws, "acme")).toBeUndefined();
    expect(readCursor(ws, "other")).toBe("cur_2");
  });

  test("is a no-op for a connector that never had one", async () => {
    expect(await clearCursor(store, wsId, "never-installed")).toBe(false);
  });
});
