/**
 * The cursor shares the workspace record with `hooks`, and shares the
 * `notifications` block itself with the source ceilings and routes an admin
 * writes. Three properties matter here and nowhere else:
 *
 *   - a cursor write and a hooks write cannot lose each other, because
 *     `WorkspaceStore.update` patches a snapshot it read itself;
 *   - a cursor write and a settings write cannot lose each other either, for
 *     the same reason one field deeper — they go through one reader and one
 *     writer of the whole block; and
 *   - uninstalling a connector drops its position, so a reinstall bootstraps.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateRegistrations } from "../../../src/hooks/registrations.ts";
import {
  readNotificationsConfig,
  updateNotificationsConfig,
} from "../../../src/notifications/config.ts";
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
    // A cursor the runtime cannot hand back verbatim is not a position;
    // dropping it bootstraps that connector, which loses nothing it had.
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

describe("the block has two authors and one home", () => {
  /** A settings write, exactly as the admin-facing tools make one. */
  async function writeSettings() {
    await updateNotificationsConfig(store, wsId, (current) => ({
      ...current,
      sources: { acme: { maxLevel: "urgent" } },
      routes: [
        {
          id: "rt_1",
          createdBy: "usr_admin",
          match: { source: "acme" },
          deliver: [{ kind: "tool", tool: "slack__send_message", input: { text: "{{title}}" } }],
        },
      ],
    }));
  }

  test("a settings write does not drop the poller's cursors", async () => {
    // `WorkspaceStore.update` replaces a patched field whole, so a settings
    // write that re-derived only `sources` and `routes` would persist an empty
    // `cursors` — and every connector would silently replay from bootstrap.
    await writeCursor(store, wsId, "acme", "cur_1");
    await writeSettings();

    expect(readCursor(await record(), "acme")).toBe("cur_1");
  });

  test("a cursor write does not drop the operator's settings", async () => {
    await writeSettings();
    await writeCursor(store, wsId, "acme", "cur_1");

    const config = readNotificationsConfig(await record());
    expect(config.sources?.acme?.maxLevel).toBe("urgent");
    expect(config.routes?.[0]?.id).toBe("rt_1");
    expect(config.cursors?.acme).toBe("cur_1");
  });

  test("the two racing on one workspace do not lose each other", async () => {
    await Promise.all([writeSettings(), writeCursor(store, wsId, "acme", "cur_1")]);

    const config = readNotificationsConfig(await record());
    expect(config.routes?.[0]?.id).toBe("rt_1");
    expect(config.cursors?.acme).toBe("cur_1");
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
