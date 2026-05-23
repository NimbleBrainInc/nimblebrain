/**
 * Stage 2 disk-read boundary: refs carrying the legacy `oauthScope: "user"`
 * literal in `workspaces/<wsId>/workspace.json#bundles[]` hard-error at
 * boot. The runtime does NOT migrate or normalize at startup — operators
 * are expected to have run `bun run migrate:user-creds` per the deploy
 * runbook (`nimblebrain-ops/research/delegation-model/STAGE_2_DEPLOY.md`).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyOAuthScopeError } from "../../src/bundles/lifecycle.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { writeJsonAtomic } from "../../src/util/atomic-json.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const USER_ID = "user_legacy_alpha";

async function makeWorkDir(prefix: string): Promise<string> {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(workDir, { recursive: true });
  return workDir;
}

async function seedWorkspaceWithLegacyBundle(workDir: string, userId: string): Promise<void> {
  const wsId = personalWorkspaceIdFor(userId);
  const wsDir = join(workDir, "workspaces", wsId);
  mkdirSync(wsDir, { recursive: true });
  const wsJson = {
    id: wsId,
    name: "Personal",
    members: [{ userId, role: "admin" }],
    bundles: [
      // Legacy on-disk shape: pre-Stage-2 records carried oauthScope: "user".
      {
        url: "https://granola.so/mcp",
        serverName: "granola",
        oauthScope: "user",
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isPersonal: true,
    ownerUserId: userId,
    about: null,
  };
  await writeJsonAtomic(join(wsDir, "workspace.json"), wsJson);
}

describe("Stage 2 — legacy oauthScope on disk hard-errors at boot", () => {
  let workDir: string | null = null;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it("boot fails with LegacyOAuthScopeError when a workspace.json carries a legacy ref", async () => {
    workDir = await makeWorkDir("nb-legacy-boot-");
    await seedWorkspaceWithLegacyBundle(workDir, USER_ID);

    let caught: unknown = null;
    try {
      const rt = await Runtime.start({
        model: { provider: "custom", adapter: createEchoModel() },
        noDefaultBundles: true,
        logging: { disabled: true },
        workDir,
      });
      await rt.shutdown();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LegacyOAuthScopeError);
    const e = caught as LegacyOAuthScopeError;
    expect(e.serverName).toBe("granola");
    expect(e.message).toContain("migrate:user-creds");
    expect(e.message).toContain("STAGE_2_DEPLOY.md");
  });
});
