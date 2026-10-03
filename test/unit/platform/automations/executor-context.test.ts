import { describe, expect, test } from "bun:test";
import type { UserIdentity } from "../../../../src/identity/provider.ts";
import {
  createDirectExecutor,
  type TaskFnRequest,
} from "../../../../src/platform/automations/executor.ts";
import { resolveExecutorContext } from "../../../../src/platform/automations/source.ts";
import type { Automation } from "../../../../src/platform/automations/types.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";

// The automation under test is owned by, and focused on, workspace A.
const automation = {
  id: "nb-morning-sweep",
  name: "Morning sweep",
  prompt: "Sweep the inbox",
  ownerId: "usr_owner_a",
  workspaceId: "ws_0009cebdf778aef6",
} as Automation;

// An org admin clicking Run now from another workspace: the context a manual
// run is dispatched inside.
const adminElsewhere = {
  identity: {
    id: "usr_admin_b",
    email: "b@example.com",
    displayName: "B",
    orgRole: "admin",
  } as UserIdentity,
  workspaceId: "ws_001de97502167e3d",
};

describe("resolveExecutorContext", () => {
  test("acts as the automation's owner, in the automation's workspace", () => {
    const ctx = resolveExecutorContext(automation);
    expect(ctx.workspaceId).toBe("ws_0009cebdf778aef6");
    expect(ctx.identity).toEqual({ id: "usr_owner_a" });
  });

  // The scheduler's timer and the notifications poller can run inside a
  // context some earlier request left behind. Who a run acts as never rests on
  // what that context holds.
  test("ignores an ambient request context for another workspace and person", () => {
    const ctx = runWithRequestContext(adminElsewhere, () => resolveExecutorContext(automation));
    expect(ctx.workspaceId).toBe("ws_0009cebdf778aef6");
    expect(ctx.identity).toEqual({ id: "usr_owner_a" });
  });

  // The identity carries the owner's id and nothing else: no org role, so the
  // run's tools are the same however it was woken.
  test("carries no org role", () => {
    expect(resolveExecutorContext(automation).identity).not.toHaveProperty("orgRole");
  });

  test("an automation lacking owner/workspace yields undefined fields", () => {
    const ctx = resolveExecutorContext({ id: "x" } as Automation);
    expect(ctx.workspaceId).toBeUndefined();
    expect(ctx.identity).toBeUndefined();
  });
});

// Run now is the scheduled run, run now: the task the executor hands the
// runtime names the same workspace and the same identity for both triggers,
// even when an org admin in another workspace clicks the button.
describe("a manual run builds the scheduled run's context", () => {
  test("manual and scheduled runs send the same workspace and identity", async () => {
    const requests: TaskFnRequest[] = [];
    const executor = createDirectExecutor(async (req) => {
      requests.push(req);
      return {
        output: "ok",
        runId: "run_test000000",
        toolCalls: [],
        stopReason: "complete",
        usage: { inputTokens: 1, outputTokens: 1, iterations: 1 },
      };
    }, resolveExecutorContext);

    await runWithRequestContext(adminElsewhere, () => executor(automation, undefined, "manual"));
    await executor(automation, undefined, "scheduled");

    const [manual, scheduled] = requests;
    expect(manual?.trigger).toBe("manual");
    expect(scheduled?.trigger).toBe("schedule");
    expect(manual?.workspaceId).toBe("ws_0009cebdf778aef6");
    expect(manual?.identity).toEqual({ id: "usr_owner_a" });
    expect({ workspaceId: manual?.workspaceId, identity: manual?.identity }).toEqual({
      workspaceId: scheduled?.workspaceId,
      identity: scheduled?.identity,
    });
  });
});
