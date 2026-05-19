/**
 * Conversation persistence tests.
 *
 * Post-Stage-1 (Task 005) every conversation lives at
 * `{workDir}/conversations/{convId}.jsonl` — the workspace-scoped
 * layout under `workspaces/<wsId>/conversations/` is gone.
 * `workspaceId` is still stamped on the metadata line so each
 * conversation knows which workspace it runs against for tool scoping,
 * but it's not a path concern.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-ws-conv-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/** Helper: create a workspace and ensure its registry is provisioned. */
async function createWorkspace(runtime: Runtime, name: string): Promise<string> {
  const wsStore = runtime.getWorkspaceStore();
  const ws = await wsStore.create(name);
  await runtime.ensureWorkspaceRegistry(ws.id);
  return ws.id;
}

function topLevelConvPath(workDir: string, convId: string): string {
  return join(workDir, "conversations", `${convId}.jsonl`);
}

function workspaceConvPath(workDir: string, wsId: string, convId: string): string {
  return join(workDir, "workspaces", wsId, "conversations", `${convId}.jsonl`);
}

describe("conversation persistence — top-level layout", () => {
  it("chat without workspaceId throws", async () => {
    const workDir = join(testDir, "global");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    try {
      await expect(
        runtime.chat({ message: "hello global" }),
      ).rejects.toThrow("workspaceId is required");
    } finally {
      await runtime.shutdown();
    }
  });

  it("chat with explicit workspaceId creates conversation at top-level (not under workspaces/)", async () => {
    const workDir = join(testDir, "explicit-ws");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    await provisionTestWorkspace(runtime);

    const result = await runtime.chat({
      message: "hello workspace",
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(result.conversationId).toMatch(/^conv_/);
    expect(result.workspaceId).toBe(TEST_WORKSPACE_ID);

    // Conversation file lives at the top-level dir.
    expect(existsSync(topLevelConvPath(workDir, result.conversationId))).toBe(true);
    // And NOT under workspaces/<wsId>/conversations/. Stage 1 Task 005
    // deleted that path entirely.
    expect(
      existsSync(workspaceConvPath(workDir, TEST_WORKSPACE_ID, result.conversationId)),
    ).toBe(false);

    await runtime.shutdown();
  });

  it("chat across multiple workspaces shares one top-level conversations directory", async () => {
    const workDir = join(testDir, "multi-ws-one-dir");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const wsId = await createWorkspace(runtime, "Engineering");

    const result = await runtime.chat({
      message: "hello workspace",
      workspaceId: wsId,
    });

    expect(result.conversationId).toMatch(/^conv_/);
    expect(result.workspaceId).toBe(wsId);
    expect(existsSync(topLevelConvPath(workDir, result.conversationId))).toBe(true);
    // No per-workspace conversation dir created for either ws.
    expect(existsSync(workspaceConvPath(workDir, wsId, result.conversationId))).toBe(false);

    await runtime.shutdown();
  });

  it("conversation metadata includes ownerId and workspaceId at the top-level file", async () => {
    const workDir = join(testDir, "ws-meta");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const wsId = await createWorkspace(runtime, "Sales");

    const result = await runtime.chat({
      message: "hello metadata",
      workspaceId: wsId,
      identity: { id: "user_alice", email: "alice@example.com" },
    });

    // Read the JSONL file and check the metadata line. workspaceId
    // survives on the metadata (tool scoping) even though the file
    // itself is at top-level (user-owned).
    const convFile = topLevelConvPath(workDir, result.conversationId);
    const content = readFileSync(convFile, "utf-8");
    const metadataLine = JSON.parse(content.split("\n")[0]!);

    expect(metadataLine.workspaceId).toBe(wsId);
    expect(metadataLine.ownerId).toBe("user_alice");

    await runtime.shutdown();
  });

  it("user messages include userId from identity", async () => {
    const workDir = join(testDir, "ws-userid");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const wsId = await createWorkspace(runtime, "Dev Team");

    const result = await runtime.chat({
      message: "hello userId",
      workspaceId: wsId,
      identity: { id: "user_bob", email: "bob@example.com" },
    });

    const convFile = topLevelConvPath(workDir, result.conversationId);
    const content = readFileSync(convFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    // Line 0 = metadata, lines 1+ = events (user.message, run.start, llm.response, run.done)
    const userEvent = lines.slice(1).map((l) => JSON.parse(l)).find((e: Record<string, unknown>) => e.type === "user.message");

    expect(userEvent).toBeDefined();
    expect(userEvent.userId).toBe("user_bob");

    await runtime.shutdown();
  });

  it("resuming a conversation loads from the top-level path", async () => {
    const workDir = join(testDir, "ws-resume");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const wsId = await createWorkspace(runtime, "Resume Test");

    // First message creates the conversation in the top-level dir.
    const result1 = await runtime.chat({
      message: "first message",
      workspaceId: wsId,
      identity: { id: "user_carol", email: "carol@example.com" },
    });

    // Wait briefly for fire-and-forget title generation to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Second message resumes the same conversation.
    const result2 = await runtime.chat({
      message: "second message",
      conversationId: result1.conversationId,
      workspaceId: wsId,
      identity: { id: "user_carol", email: "carol@example.com" },
    });

    expect(result2.conversationId).toBe(result1.conversationId);

    const convFile = topLevelConvPath(workDir, result1.conversationId);
    expect(existsSync(convFile)).toBe(true);

    // Wait for any pending writes (title generation + metadata cache).
    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = readFileSync(convFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    // Event format: metadata (1) + user.message + run.start + llm.response + run.done per turn × 2.
    expect(lines.length).toBeGreaterThanOrEqual(5);

    await runtime.shutdown();
  });

  it("no userId on user message when identity is absent", async () => {
    const workDir = join(testDir, "no-identity");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    await provisionTestWorkspace(runtime);

    // Chat with explicit workspaceId but no identity.
    const result = await runtime.chat({
      message: "no identity",
      workspaceId: TEST_WORKSPACE_ID,
    });

    const convFile = topLevelConvPath(workDir, result.conversationId);
    const content = readFileSync(convFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const userEvent = lines.slice(1).map((l) => JSON.parse(l)).find((e: Record<string, unknown>) => e.type === "user.message");

    expect(userEvent).toBeDefined();
    expect(userEvent.type).toBe("user.message");
    expect(userEvent.userId).toBeUndefined();

    await runtime.shutdown();
  });
});
