/**
 * Conversation persistence tests.
 *
 * Conversations are workspace-owned: each lives at
 * `{workDir}/workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl`. An
 * identity-bound dev-mode chat with no `workspaceId` is born in the caller's
 * default workspace (provisioned for them if they have none), with the owner as
 * the privacy sub-partition. The old flat `{workDir}/conversations/` layout is gone.
 *
 * Stage 2 (T006) made the chat surface identity-bound:
 * `ChatRequest.workspaceId` is removed and `ChatResult.workspaceId` with
 * it. The `workspaceId` on conversation metadata is the session's
 * workspace — the workspace binding and a breadcrumb for legacy single-workspace
 * reads (overlays, file store) — not a per-call attribution. Per-call
 * workspace lives on each `tool.done` event's `workspaceId`, stamped by the
 * orchestrator from the parsed namespace.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceConversationsDir } from "../../../src/conversation/paths.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

const testDir = join(tmpdir(), `nb-ws-conv-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/** The owner's own workspace: their only one, created with them as admin if they have none. */
async function defaultWorkspaceId(runtime: Runtime, ownerId: string): Promise<string> {
  const store = runtime.getWorkspaceStore();
  const [ws] = await store.getWorkspacesForUser(ownerId);
  if (ws) return ws.id;
  const created = await store.create("Home", {
    members: [{ userId: ownerId, role: "admin" }],
  });
  await runtime.ensureWorkspaceRegistry(created.id);
  return created.id;
}

/** The workspace-owned path for a conversation born in `ownerId`'s default workspace. */
async function defaultWorkspaceConvPath(
  runtime: Runtime,
  workDir: string,
  ownerId: string,
  convId: string,
): Promise<string> {
  return join(
    workspaceConversationsDir(workDir, await defaultWorkspaceId(runtime, ownerId), ownerId),
    `${convId}.jsonl`,
  );
}

function flatConvPath(workDir: string, convId: string): string {
  return join(workDir, "conversations", `${convId}.jsonl`);
}

describe("conversation persistence — workspace layout", () => {
  it("chat with identity creates conversation in the owner's default workspace (not flat)", async () => {
    const workDir = join(testDir, "identity-bound");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
    });

    const identity = {
      id: "usr_alice",
      email: "alice@example.com",
      displayName: "Alice",
      orgRole: "member" as const,
      preferences: {},
    };

    const result = await runtime.chat({
      message: "hello",
      identity,
      workspaceId: await defaultWorkspaceId(runtime, identity.id),
    });
    expect(result.conversationId).toMatch(/^conv_/);

    // File lives under the default workspace's owner partition.
    expect(
      existsSync(
        await defaultWorkspaceConvPath(runtime, workDir, identity.id, result.conversationId),
      ),
    ).toBe(true);

    // Not at the old flat top-level path.
    expect(existsSync(flatConvPath(workDir, result.conversationId))).toBe(false);

    await runtime.shutdown();
  });

  it("chats across multiple invocations share one workspace conversations directory", async () => {
    const workDir = join(testDir, "many-convs-one-dir");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
    });

    const identity = {
      id: "usr_alice",
      email: "alice@example.com",
      displayName: "Alice",
      orgRole: "member" as const,
      preferences: {},
    };

    const r1 = await runtime.chat({
      message: "hello 1",
      identity,
      workspaceId: await defaultWorkspaceId(runtime, identity.id),
    });
    const r2 = await runtime.chat({
      message: "hello 2",
      identity,
      workspaceId: await defaultWorkspaceId(runtime, identity.id),
    });

    expect(
      existsSync(await defaultWorkspaceConvPath(runtime, workDir, identity.id, r1.conversationId)),
    ).toBe(true);
    expect(
      existsSync(await defaultWorkspaceConvPath(runtime, workDir, identity.id, r2.conversationId)),
    ).toBe(true);

    await runtime.shutdown();
  });

  it("conversation metadata includes ownerId and a workspace breadcrumb", async () => {
    const workDir = join(testDir, "ws-meta");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
    });

    const identity = {
      id: "user_alice",
      email: "alice@example.com",
      displayName: "Alice",
      orgRole: "member" as const,
      preferences: {},
    };

    const result = await runtime.chat({
      message: "hello metadata",
      identity,
      workspaceId: await defaultWorkspaceId(runtime, identity.id),
    });

    const convFile = await defaultWorkspaceConvPath(
      runtime,
      workDir,
      identity.id,
      result.conversationId,
    );
    const content = readFileSync(convFile, "utf-8");
    const metadataLine = JSON.parse(content.split("\n")[0]!);

    expect(metadataLine.ownerId).toBe("user_alice");
    // The metadata `workspaceId` is the session's workspace — here the owner's
    // default one, provisioned with an opaque id. Per-call workspaceId lives
    // on tool.done events.
    expect(metadataLine.workspaceId).toBe(await defaultWorkspaceId(runtime, identity.id));
    expect(metadataLine.workspaceId).toMatch(/^ws_[0-9a-f]{16}$/);

    await runtime.shutdown();
  });

  it("user messages include userId from identity", async () => {
    const workDir = join(testDir, "ws-userid");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
    });

    const identity = {
      id: "user_bob",
      email: "bob@example.com",
      displayName: "Bob",
      orgRole: "member" as const,
      preferences: {},
    };

    const result = await runtime.chat({
      message: "hello userId",
      identity,
      workspaceId: await defaultWorkspaceId(runtime, identity.id),
    });

    const convFile = await defaultWorkspaceConvPath(
      runtime,
      workDir,
      identity.id,
      result.conversationId,
    );
    const content = readFileSync(convFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const userEvent = lines
      .slice(1)
      .map((l) => JSON.parse(l))
      .find((e: Record<string, unknown>) => e.type === "user.message");

    expect(userEvent).toBeDefined();
    expect(userEvent.userId).toBe("user_bob");

    await runtime.shutdown();
  });

  it("resuming a conversation loads from the workspace path", async () => {
    const workDir = join(testDir, "ws-resume");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      languageModel: createEchoModel(),
      workDir,
    });

    const identity = {
      id: "user_carol",
      email: "carol@example.com",
      displayName: "Carol",
      orgRole: "member" as const,
      preferences: {},
    };

    const result1 = await runtime.chat({
      message: "first message",
      identity,
      workspaceId: await defaultWorkspaceId(runtime, identity.id),
    });

    // Wait briefly for fire-and-forget title generation to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result2 = await runtime.chat({
      message: "second message",
      conversationId: result1.conversationId,
      identity,
      workspaceId: await defaultWorkspaceId(runtime, identity.id),
    });

    expect(result2.conversationId).toBe(result1.conversationId);

    const convFile = await defaultWorkspaceConvPath(
      runtime,
      workDir,
      identity.id,
      result1.conversationId,
    );
    expect(existsSync(convFile)).toBe(true);

    // Wait for any pending writes (title generation + metadata cache).
    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = readFileSync(convFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(5);

    await runtime.shutdown();
  });
});
