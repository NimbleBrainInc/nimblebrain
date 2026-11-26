/**
 * A deactivated user's unattended work does not run.
 *
 * Deactivation stamps `deletedAt` on the user record and keeps their workspace
 * memberships, so `restore` brings them back. Unattended work never signs in,
 * so the sign-in refusal does not reach it; the run-start door and the
 * unattended dispatch both ask `isPrincipalWorkspaceMember`, which refuses a
 * tombstoned principal. The refusal is the membership one, so the scheduler
 * records the run as skipped and the task resumes when the user is restored.
 *
 * A member with no user record is still admitted: a membership can name an id
 * whose profile is not written yet, and an absent record revokes nothing.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { createDirectExecutor } from "../../../src/platform/tasks/executor.ts";
import { Scheduler } from "../../../src/platform/tasks/scheduler.ts";
import { resolveExecutorContext } from "../../../src/platform/tasks/source.ts";
import { loadOwnerTasks, saveTask } from "../../../src/platform/tasks/store.ts";
import type { Task } from "../../../src/platform/tasks/types.ts";
import { WorkspaceMembershipRevokedError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import type { TaskRequest } from "../../../src/runtime/types.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
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

function taskFor(ownerId: string): Task {
  const now = new Date().toISOString();
  return {
    id: "daily",
    name: "Daily",
    prompt: "do the thing",
    ownerId,
    workspaceId: WS,
    source: "user",
    enabled: true,
    schedule: { type: "interval", intervalMs: 3_600_000 },
    consecutiveErrors: 0,
    runCount: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    createdAt: now,
    updatedAt: now,
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
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

  it("is recorded skipped by the scheduler, with no error streak, and resumes after restore", async () => {
    const runtime = await startRuntime("scheduler");
    let stopScheduler = () => {};
    try {
      const owner = await seedMember(runtime, "owner@acme-corp.example");
      const workDir = join(testDir, "scheduler");
      saveTask(workDir, WS, owner.id, taskFor(owner.id));
      const executor = createDirectExecutor(
        (req) => runtime.executeTask(req as TaskRequest),
        resolveExecutorContext,
      );
      const scheduler = new Scheduler(executor, { workDir });
      scheduler.start();
      stopScheduler = () => scheduler.stop();

      await runtime.getUserStore().softDelete(owner.id);
      const skipped = await scheduler.runNow(WS, owner.id, "daily");
      expect(skipped?.status).toBe("skipped");
      const afterSkip = loadOwnerTasks(workDir, WS, owner.id).get("daily");
      expect(afterSkip?.consecutiveErrors).toBe(0);
      expect(afterSkip?.enabled).toBe(true);

      await runtime.getUserStore().restore(owner.id);
      const resumed = await scheduler.runNow(WS, owner.id, "daily");
      expect(resumed?.status).toBe("success");
    } finally {
      stopScheduler();
      await runtime.shutdown();
    }
  }, 20_000);

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
