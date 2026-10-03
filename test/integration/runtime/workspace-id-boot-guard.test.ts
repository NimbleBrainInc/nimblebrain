/**
 * Boot refuses a workspace whose directory name is not a generated id
 * (`ws_<16-hex>`), naming each one, rather than serve without it (ADR-0042).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { NonConformingWorkspaceIdError } from "../../../src/workspace/migration-guard.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { makeTestWorkDir } from "../../helpers/test-workdir.ts";

let runtime: Runtime | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await runtime?.shutdown();
  cleanup?.();
  runtime = undefined;
  cleanup = undefined;
});

function placeWorkspace(workDir: string, id: string): void {
  const dir = join(workDir, "workspaces", id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, "workspace.json"),
    JSON.stringify({ id, name: id, members: [], connectors: [], createdAt: now, updatedAt: now }),
  );
}

function start(workspaceIds: readonly string[]): Promise<Runtime> {
  const dir = makeTestWorkDir("workspace-id-guard");
  cleanup = dir.cleanup;
  writeFileSync(join(dir.workDir, "instance.json"), JSON.stringify({ auth: { adapter: "dev" } }));
  for (const id of workspaceIds) placeWorkspace(dir.workDir, id);
  return Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: dir.workDir,
  });
}

describe("workspace id boot guard", () => {
  it("refuses to start while a workspace has a slug or user-derived id, naming each", async () => {
    const started = start(["ws_3f9a1c7e0b2d4856", "ws_acme_corp", "ws_user_usr_alice"]);
    await expect(started).rejects.toBeInstanceOf(NonConformingWorkspaceIdError);
    await expect(started).rejects.toThrow("ws_acme_corp, ws_user_usr_alice");
  });

  it("starts when every workspace has a generated id", async () => {
    runtime = await start(["ws_3f9a1c7e0b2d4856"]);
    expect((await runtime.getWorkspaceStore().list()).map((w) => w.id)).toEqual([
      "ws_3f9a1c7e0b2d4856",
    ]);
  });
});
