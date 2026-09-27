/**
 * An automation run (`executeTask`) requires current membership of its
 * provenance workspace.
 *
 * An automation fires AS its owner, walled to the workspace it was created in.
 * Membership there is validated at create, not per run — so a since-removed owner
 * would otherwise keep acting in a workspace they left. `executeTask` denies the
 * run early with `WorkspaceMembershipRevokedError` (the automations analog of the
 * conversation resume gate). A member's run, and a dev-mode task that names no
 * workspace (it runs in the caller's default one), are not refused.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { WorkspaceMembershipRevokedError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-automation-membership-${Date.now()}`);
const WORKSPACE_A = "ws_workspace_a";
const OWNER = DEV_IDENTITY.id;

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

async function startRuntime(name: string): Promise<Runtime> {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  return Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
  });
}

describe("executeTask requires current membership of the automation's provenance workspace", () => {
  it("denies a run whose owner was removed from the provenance workspace", async () => {
    const runtime = await startRuntime("removed");
    await provisionTestWorkspace(runtime, WORKSPACE_A, "Alpha");

    // Runs while a member.
    const ok = await runtime.executeTask({ prompt: "do the thing", workspaceId: WORKSPACE_A });
    expect(ok.output).toBeDefined();

    // Owner is offboarded from A.
    await runtime.getWorkspaceStore().removeMember(WORKSPACE_A, OWNER);

    let thrown: unknown;
    try {
      await runtime.executeTask({ prompt: "do the thing", workspaceId: WORKSPACE_A });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WorkspaceMembershipRevokedError);
    expect((thrown as WorkspaceMembershipRevokedError).code).toBe("workspace_membership_revoked");
    expect((thrown as WorkspaceMembershipRevokedError).workspaceId).toBe(WORKSPACE_A);

    await runtime.shutdown();
  });

  it("does not gate a sole member's task or a dev-mode workspaceless task", async () => {
    const runtime = await startRuntime("own");
    const own = await runtime.getWorkspaceStore().create("Own", undefined, {
      members: [{ userId: OWNER, role: "admin" }],
    });
    const ownRun = await runtime.executeTask({ prompt: "own task", workspaceId: own.id });
    expect(ownRun.output).toBeDefined();

    const none = await runtime.executeTask({ prompt: "no workspace" });
    expect(none.output).toBeDefined();

    await runtime.shutdown();
  });
});
