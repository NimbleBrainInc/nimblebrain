/**
 * The single sanctioned file-path construction/parse site. Pins the room-owned
 * layout: bytes under `workspaces/<wsId>/files/<ownerId>/`, `_runs/` reserved.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseFilesPath, roomFilesDir, runFilesDir } from "../../../src/files/paths.ts";

const WORK = "/wd";

test("roomFilesDir builds the owner partition under the room", () => {
  expect(roomFilesDir(WORK, "ws_helix", "usr_alice")).toBe(
    join(WORK, "workspaces", "ws_helix", "files", "usr_alice"),
  );
});

test("runFilesDir builds the reserved automation partition", () => {
  expect(runFilesDir(WORK, "ws_helix", "auto_x")).toBe(
    join(WORK, "workspaces", "ws_helix", "files", "_runs", "auto_x"),
  );
});

test("roomFilesDir rejects the reserved _runs ownerId", () => {
  // A user whose ownerId were literally `_runs` would have their files misparsed
  // as automation outputs — fail closed rather than collide.
  expect(() => roomFilesDir(WORK, "ws_helix", "_runs")).toThrow(/reserved/);
});

test("parseFilesPath round-trips an owner-partition path", () => {
  const p = join(roomFilesDir(WORK, "ws_helix", "usr_alice"), "fl_abc_doc.pdf");
  expect(parseFilesPath(p)).toEqual({ wsId: "ws_helix", ownerId: "usr_alice", automationId: null });
});

test("parseFilesPath round-trips a _runs path", () => {
  const p = join(runFilesDir(WORK, "ws_helix", "auto_x"), "fl_abc_out.csv");
  expect(parseFilesPath(p)).toEqual({ wsId: "ws_helix", ownerId: null, automationId: "auto_x" });
});

test("parseFilesPath returns null for a non-room path", () => {
  expect(parseFilesPath(join(WORK, "users", "usr_alice", "files", "fl_abc_doc.pdf"))).toBeNull();
});
