import { describe, expect, it } from "bun:test";
import { WorkspaceMembershipRevokedError } from "../../../src/runtime/errors.ts";
import type { RunSpec } from "../../../src/runtime/run-spec.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";

/**
 * The run doors wait for `start()` to finish assembling the workspace
 * registries. The automations scheduler is started inside `start()`, before the
 * workspace connectors, and fires an overdue automation at once; composed then,
 * the run saw a stand-in registry with no connectors and reported the
 * workspace's connectors as not installed.
 *
 * Driven against a prototype-built Runtime with the barrier seeded by hand — a
 * full boot resolves it before returning, which is exactly what hides the race.
 */
interface Probe {
  runtime: Runtime;
  boot: PromiseWithResolvers<void>;
  /** Whether the door got past the barrier to its first workspace read. */
  reached: () => boolean;
}

function bootingRuntime(): Probe {
  const rt = Object.create(Runtime.prototype) as Runtime;
  const boot = Promise.withResolvers<void>();
  let reached = false;
  const fields = rt as unknown as {
    _bootReady: PromiseWithResolvers<void>;
    isPrincipalWorkspaceMember: () => Promise<boolean>;
  };
  fields._bootReady = boot;
  // The first thing `startRun` does past the barrier. Answering "not a member"
  // ends the run there with a typed refusal, so the test needs nothing else.
  fields.isPrincipalWorkspaceMember = async () => {
    reached = true;
    return false;
  };
  return { runtime: rt, boot, reached: () => reached };
}

const scheduledRun = {
  trigger: "schedule",
  principal: { identity: { id: "user-a" }, ownerId: "user-a" },
  workspaceId: "ws_a",
  briefingWorkspaceId: "ws_a",
  input: { content: [{ type: "text", text: "go" }], userId: "user-a" },
  budget: {},
  model: "test:model",
  onAbort: "partial",
} as unknown as RunSpec;

describe("Runtime run doors — boot barrier", () => {
  it("test_startRun_beforeBootCompletes_waitsForBoot", async () => {
    const { runtime, boot, reached } = bootingRuntime();
    const run = runtime.startRun(scheduledRun);

    await Bun.sleep(5);
    expect(reached()).toBe(false);

    boot.resolve();
    await expect(run).rejects.toBeInstanceOf(WorkspaceMembershipRevokedError);
    expect(reached()).toBe(true);
  });

  it("test_startRun_bootFails_rejectsWithBootError", async () => {
    const { runtime, boot, reached } = bootingRuntime();
    const run = runtime.startRun(scheduledRun);

    boot.reject(new Error("boot failed"));
    await expect(run).rejects.toThrow("boot failed");
    expect(reached()).toBe(false);
  });

  it("test_dispatchUnattended_bootFails_rejectsBeforeRouting", async () => {
    const { runtime, boot } = bootingRuntime();
    const dispatch = runtime.dispatchUnattended({} as Parameters<Runtime["dispatchUnattended"]>[0]);

    boot.reject(new Error("boot failed"));
    await expect(dispatch).rejects.toThrow("boot failed");
  });
});
