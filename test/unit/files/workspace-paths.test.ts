/**
 * The single sanctioned file-path construction/parse site. Pins the workspace-owned
 * layout: bytes under `workspaces/<wsId>/files/<ownerId>/`.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseFilesPath, workspaceFilesDir } from "../../../src/files/paths.ts";

const WORK = "/wd";

test("workspaceFilesDir builds the owner partition under the workspace", () => {
  expect(workspaceFilesDir(WORK, "ws_003eba8844413cd9", "usr_alice")).toBe(
    join(WORK, "workspaces", "ws_003eba8844413cd9", "files", "usr_alice"),
  );
});

test("parseFilesPath round-trips an owner-partition path", () => {
  const p = join(workspaceFilesDir(WORK, "ws_003eba8844413cd9", "usr_alice"), "fl_abc_doc.pdf");
  expect(parseFilesPath(p)).toEqual({ wsId: "ws_003eba8844413cd9", ownerId: "usr_alice" });
});

test("parseFilesPath returns null for a non-workspace path", () => {
  expect(parseFilesPath(join(WORK, "users", "usr_alice", "files", "fl_abc_doc.pdf"))).toBeNull();
});
