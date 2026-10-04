import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { RunInProgressError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-concurrent-chat-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("concurrent chat rejection", () => {
  it("rejects a second chat on the same conversation while the first is in flight", async () => {
    const workDir = join(testDir, "concurrent");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createEchoModel() },
      workDir,
    });
    await provisionTestWorkspace(runtime);

    // First call — seed a conversation so we have an id to contend on.
    const first = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "first",
      workspaceId: TEST_WORKSPACE_ID,
    });
    const convId = first.conversationId;

    // Start a second chat but do not await — the lock is acquired synchronously
    // before the first internal await, so by the time control returns here the
    // conversation is registered as active.
    const inFlight = runtime.chat({
      identity: DEV_IDENTITY,
      message: "in-flight",
      conversationId: convId,
      workspaceId: TEST_WORKSPACE_ID,
    });

    // A concurrent call on the same conversation must reject cleanly.
    await expect(
      runtime.chat({
        identity: DEV_IDENTITY,
        message: "interrupting",
        conversationId: convId,
        workspaceId: TEST_WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(RunInProgressError);

    // Let the in-flight call finish; lock must release.
    await inFlight;

    // And a subsequent call on the same conversation must succeed normally.
    const third = await runtime.chat({
      identity: DEV_IDENTITY,
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
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createEchoModel() },
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const a = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "a",
      workspaceId: TEST_WORKSPACE_ID,
    });
    const b = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "b",
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(a.conversationId).not.toBe(b.conversationId);

    // Parallel resumes on the two distinct conversations must both succeed.
    const [ra, rb] = await Promise.all([
      runtime.chat({
        identity: DEV_IDENTITY,
        message: "a2",
        conversationId: a.conversationId,
        workspaceId: TEST_WORKSPACE_ID,
      }),
      runtime.chat({
        identity: DEV_IDENTITY,
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
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createEchoModel() },
      workDir,
    });
    await provisionTestWorkspace(runtime);

    // Seed a conversation as Alice, then provoke a throw by resuming it as
    // Bob — the single-owner gate refuses him. The point of this test is the
    // lock-release contract, not the throw mechanism.
    const alice = {
      id: "usr_alice",
      email: "alice@example.com",
      displayName: "Alice",
      orgRole: "member" as const,
      preferences: {},
    };
    const bob = {
      id: "usr_bob",
      email: "bob@example.com",
      displayName: "Bob",
      orgRole: "member" as const,
      preferences: {},
    };

    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, alice.id, "member");
    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, bob.id, "member");
    const seed = await runtime.chat({
      message: "seed",
      identity: alice,
      workspaceId: TEST_WORKSPACE_ID,
    });
    const convId = seed.conversationId;

    await expect(
      runtime.chat({
        message: "bad",
        conversationId: convId,
        identity: bob,
        workspaceId: TEST_WORKSPACE_ID,
      }),
    ).rejects.toThrow();

    // The refused call released the lock: the owner's next turn runs.
    await expect(
      runtime.chat({
        message: "after",
        conversationId: convId,
        identity: alice,
        workspaceId: TEST_WORKSPACE_ID,
      }),
    ).resolves.toBeDefined();

    await runtime.shutdown();
  });
});
