/**
 * A deactivated user's unattended work does not run.
 *
 * Deactivation stamps `deletedAt` on the user record and keeps their workspace
 * memberships, so `restore` brings them back. Unattended work never signs in,
 * so the sign-in refusal does not reach it; the run-start door and the
 * unattended dispatch both ask `isPrincipalWorkspaceMember`, which refuses a
 * tombstoned principal. A task's run is checked before it starts: the run
 * worker ends it not started, `membership_revoked`, which the tasks plugin
 * records skipped and answers by disabling the task until a grant-marked call
 * re-enables it.
 *
 * A member with no user record is still admitted: a membership can name an id
 * whose profile is not written yet, and an absent record revokes nothing.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { WorkspaceMembershipRevokedError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { answer, callTasks, waitForRun } from "../../helpers/tasks-plugin.ts";
import { seedWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-deactivated-owner-${Date.now()}`);
const WS = "ws_00883d7b29214d57";

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

async function startRuntime(name: string): Promise<Runtime> {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  return Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
}

/** A real user record that is a member of `WS`. */
async function seedMember(runtime: Runtime, email: string): Promise<UserIdentity> {
  const user = await runtime
    .getUserStore()
    .create({ email, displayName: "Member", orgRole: "member" });
  await seedWorkspace(runtime.getWorkspaceStore(), WS, {
    name: "Alpha",
    members: [{ userId: user.id, role: "member" }],
  });
  await runtime.ensureWorkspaceRegistry(WS);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    orgRole: "member",
    preferences: user.preferences,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}

describe("a deactivated user's unattended work", () => {
  it("refuses the task run at the run-start door, and runs it again after restore", async () => {
    const runtime = await startRuntime("execute");
    try {
      const owner = await seedMember(runtime, "owner@acme-corp.example");
      const users = runtime.getUserStore();

      await users.softDelete(owner.id);
      // Memberships survive deactivation; the gate is what refuses.
      const ws = await runtime.getWorkspaceStore().get(WS);
      expect(ws?.members.some((m) => m.userId === owner.id)).toBe(true);
      expect(await runtime.isPrincipalWorkspaceMember(WS, owner.id)).toBe(false);

      const thrown = await refusal(() =>
        runtime.executeTask({ identity: owner, prompt: "do the thing", workspaceId: WS }),
      );
      expect(thrown).toBeInstanceOf(WorkspaceMembershipRevokedError);
      expect((thrown as WorkspaceMembershipRevokedError).code).toBe("workspace_membership_revoked");
      expect((thrown as WorkspaceMembershipRevokedError).workspaceId).toBe(WS);
      // Refused at the one door, before a run is established.
      expect((thrown as Error).stack).toContain("startRun");

      await users.restore(owner.id);
      expect(await runtime.isPrincipalWorkspaceMember(WS, owner.id)).toBe(true);
      const run = await runtime.executeTask({
        identity: owner,
        prompt: "do the thing",
        workspaceId: WS,
      });
      expect(run.output).toBeDefined();
    } finally {
      await runtime.shutdown();
    }
  });

  it("ends the task's run not started, membership revoked, and runs it again once restored and re-enabled", async () => {
    const runtime = await startRuntime("worker");
    try {
      const owner = await seedMember(runtime, "owner@acme-corp.example");
      answer(
        await callTasks(runtime, owner, WS, "create", {
          manifest: { name: "Daily" },
          body: "do the thing",
        }),
      );

      await runtime.getUserStore().softDelete(owner.id);
      const asked = answer<{ runId: string }>(
        await callTasks(runtime, owner, WS, "run", { taskId: "daily" }),
      );
      const refused = await waitForRun(runtime, owner, WS, asked.runId);
      expect(refused.run.execution).toBe("skipped");
      expect(refused.run.error).toContain("membership_revoked");
      const status = answer<{ task: { enabled: boolean } }>(
        await callTasks(runtime, owner, WS, "status", { taskId: "daily" }),
      );
      expect(status.task.enabled).toBe(false);

      await runtime.getUserStore().restore(owner.id);
      answer(
        await callTasks(runtime, owner, WS, "update", {
          taskId: "daily",
          manifest: { enabled: true },
        }),
      );
      const again = answer<{ runId: string }>(
        await callTasks(runtime, owner, WS, "run", { taskId: "daily" }),
      );
      expect((await waitForRun(runtime, owner, WS, again.runId)).run.execution).toBe("completed");
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  it("is skipped at the unattended dispatch as owner_not_member", async () => {
    const runtime = await startRuntime("dispatch");
    try {
      const owner = await seedMember(runtime, "owner@acme-corp.example");
      const dispatch = () =>
        runtime.dispatchUnattended({
          principalId: owner.id,
          workspaceId: WS,
          tool: "nb__status",
          input: {},
          reason: "test",
        });

      expect((await dispatch()).outcome).toBe("ok");

      await runtime.getUserStore().softDelete(owner.id);
      const res = await dispatch();
      expect(res.outcome).toBe("skipped");
      expect(res.classification).toBe("owner_not_member");

      await runtime.getUserStore().restore(owner.id);
      expect((await dispatch()).outcome).toBe("ok");
    } finally {
      await runtime.shutdown();
    }
  });

  it("still admits a member with no user record", async () => {
    const runtime = await startRuntime("no-record");
    try {
      const memberId = "usr_without_profile";
      await seedWorkspace(runtime.getWorkspaceStore(), WS, {
        name: "Alpha",
        members: [{ userId: memberId, role: "member" }],
      });
      await runtime.ensureWorkspaceRegistry(WS);
      expect(await runtime.getUserStore().get(memberId)).toBeNull();

      // An absent record is not a revocation: only the tombstone refuses.
      expect(await runtime.isPrincipalWorkspaceMember(WS, memberId)).toBe(true);
      const run = await runtime.executeTask({
        identity: {
          id: memberId,
          email: "",
          displayName: "No profile",
          orgRole: "member",
          preferences: {},
        },
        prompt: "do the thing",
        workspaceId: WS,
      });
      expect(run.output).toBeDefined();
    } finally {
      await runtime.shutdown();
    }
  });
});
