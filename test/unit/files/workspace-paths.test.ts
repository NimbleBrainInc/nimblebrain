/**
 * The single sanctioned file-path construction site. Pins the workspace-owned
 * layout: bytes under `workspaces/<wsId>/files/<ownerId>/`.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { workspaceFilesDir } from "../../../src/files/paths.ts";

const WORK = "/wd";

test("workspaceFilesDir builds the owner partition under the workspace", () => {
  expect(workspaceFilesDir(WORK, "ws_003eba8844413cd9", "usr_alice")).toBe(
    join(WORK, "workspaces", "ws_003eba8844413cd9", "files", "usr_alice"),
  );
});
