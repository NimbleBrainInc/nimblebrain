import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunInProgressError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-concurrent-chat-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("concurrent chat rejection", () => {
  it("rejects a second chat on the same conversation while the first is in flight", async () => {
    const workDir = join(testDir, "concurrent");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    // First call — seed a conversation so we have an id to contend on.
    const first = await runtime.chat({
      message: "first",
      workspaceId: TEST_WORKSPACE_ID,
    });
    const convId = first.conversationId;

    // Start a second chat but do not await — the lock is acquired synchronously
    // before the first internal await, so by the time control returns here the
    // conversation is registered as active.
    const inFlight = runtime.chat({
      message: "in-flight",
      conversationId: convId,
      workspaceId: TEST_WORKSPACE_ID,
    });

    expect(runtime.isConversationActive(convId)).toBe(true);

    // A concurrent call on the same conversation must reject cleanly.
    await expect(
      runtime.chat({
        message: "interrupting",
        conversationId: convId,
        workspaceId: TEST_WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(RunInProgressError);

    // Let the in-flight call finish; lock must release.
    await inFlight;
    expect(runtime.isConversationActive(convId)).toBe(false);

    // And a subsequent call on the same conversation must succeed normally.
    const third = await runtime.chat({
      message: "after",
      conversationId: convId,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(third.conversationId).toBe(convId);

    await runtime.shutdown();
  });

  it("does not block concurrent chats on different conversations", async () => {
    const workDir = join(testDir, "disjoint");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const a = await runtime.chat({ message: "a", workspaceId: TEST_WORKSPACE_ID });
    const b = await runtime.chat({ message: "b", workspaceId: TEST_WORKSPACE_ID });
    expect(a.conversationId).not.toBe(b.conversationId);

    // Parallel resumes on the two distinct conversations must both succeed.
    const [ra, rb] = await Promise.all([
      runtime.chat({
        message: "a2",
        conversationId: a.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
      }),
      runtime.chat({
        message: "b2",
        conversationId: b.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
      }),
    ]);
    expect(ra.conversationId).toBe(a.conversationId);
    expect(rb.conversationId).toBe(b.conversationId);

    await runtime.shutdown();
  });

  it("releases the lock when the first chat throws", async () => {
    const workDir = join(testDir, "release-on-throw");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const seed = await runtime.chat({ message: "seed", workspaceId: TEST_WORKSPACE_ID });
    const convId = seed.conversationId;

    // Missing workspaceId causes the inner body to throw — lock must still release.
    await expect(
      runtime.chat({ message: "bad", conversationId: convId } as unknown as Parameters<
        typeof runtime.chat
      >[0]),
    ).rejects.toThrow();

    expect(runtime.isConversationActive(convId)).toBe(false);

    await runtime.shutdown();
  });
});
