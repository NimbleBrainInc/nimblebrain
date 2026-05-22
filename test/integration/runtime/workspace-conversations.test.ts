/**
 * Conversation persistence tests.
 *
 * Post-Stage-1 (Task 005) every conversation lives at
 * `{workDir}/conversations/{convId}.jsonl` — the workspace-scoped
 * layout under `workspaces/<wsId>/conversations/` is gone.
 *
 * Stage 2 (T006) made the chat surface identity-bound:
 * `ChatRequest.workspaceId` is removed and `ChatResult.workspaceId` with
 * it. The `workspaceId` on conversation metadata is now the session
 * (personal) workspace — a breadcrumb for legacy single-workspace reads
 * (overlays, file store) — not a per-call attribution. Per-call workspace
 * lives on each `tool.done` event's `workspaceId`, stamped by the
 * orchestrator from the parsed namespace.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";

const testDir = join(tmpdir(), `nb-ws-conv-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function topLevelConvPath(workDir: string, convId: string): string {
  return join(workDir, "conversations", `${convId}.jsonl`);
}

function workspaceConvPath(workDir: string, wsId: string, convId: string): string {
  return join(workDir, "workspaces", wsId, "conversations", `${convId}.jsonl`);
}

describe("conversation persistence — top-level layout", () => {
  it("chat with identity creates conversation at top-level (not under workspaces/)", async () => {
    const workDir = join(testDir, "identity-bound");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const identity = {
      id: "usr_alice",
      email: "alice@example.com",
      displayName: "Alice",
      orgRole: "member" as const,
      preferences: {},
    };

    const result = await runtime.chat({ message: "hello", identity });
    expect(result.conversationId).toMatch(/^conv_/);

    // File at top-level.
    expect(existsSync(topLevelConvPath(workDir, result.conversationId))).toBe(true);

    // No per-workspace dir.
    const personalWsId = `ws_user_${identity.id}`;
    expect(
      existsSync(workspaceConvPath(workDir, personalWsId, result.conversationId)),
    ).toBe(false);

    await runtime.shutdown();
  });

  it("chats across multiple invocations share one top-level conversations directory", async () => {
    const workDir = join(testDir, "many-convs-one-dir");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const identity = {
      id: "usr_alice",
      email: "alice@example.com",
      displayName: "Alice",
      orgRole: "member" as const,
      preferences: {},
    };

    const r1 = await runtime.chat({ message: "hello 1", identity });
    const r2 = await runtime.chat({ message: "hello 2", identity });

    expect(existsSync(topLevelConvPath(workDir, r1.conversationId))).toBe(true);
    expect(existsSync(topLevelConvPath(workDir, r2.conversationId))).toBe(true);

    await runtime.shutdown();
  });

  it("conversation metadata includes ownerId and a personal-workspace breadcrumb", async () => {
    const workDir = join(testDir, "ws-meta");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const identity = {
      id: "user_alice",
      email: "alice@example.com",
      displayName: "Alice",
      orgRole: "member" as const,
      preferences: {},
    };

    const result = await runtime.chat({ message: "hello metadata", identity });

    const convFile = topLevelConvPath(workDir, result.conversationId);
    const content = readFileSync(convFile, "utf-8");
    const metadataLine = JSON.parse(content.split("\n")[0]!);

    expect(metadataLine.ownerId).toBe("user_alice");
    // T006: the metadata `workspaceId` is the session (personal) workspace
    // — the breadcrumb for legacy single-workspace reads. Per-call
    // workspaceId lives on tool.done events.
    expect(metadataLine.workspaceId).toBe("ws_user_user_alice");

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

    const identity = {
      id: "user_bob",
      email: "bob@example.com",
      displayName: "Bob",
      orgRole: "member" as const,
      preferences: {},
    };

    const result = await runtime.chat({ message: "hello userId", identity });

    const convFile = topLevelConvPath(workDir, result.conversationId);
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

  it("resuming a conversation loads from the top-level path", async () => {
    const workDir = join(testDir, "ws-resume");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    const identity = {
      id: "user_carol",
      email: "carol@example.com",
      displayName: "Carol",
      orgRole: "member" as const,
      preferences: {},
    };

    const result1 = await runtime.chat({ message: "first message", identity });

    // Wait briefly for fire-and-forget title generation to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result2 = await runtime.chat({
      message: "second message",
      conversationId: result1.conversationId,
      identity,
    });

    expect(result2.conversationId).toBe(result1.conversationId);

    const convFile = topLevelConvPath(workDir, result1.conversationId);
    expect(existsSync(convFile)).toBe(true);

    // Wait for any pending writes (title generation + metadata cache).
    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = readFileSync(convFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(5);

    await runtime.shutdown();
  });

  it("dev-mode chat (no identity on request) creates a user-message event with no userId stamp", async () => {
    const workDir = join(testDir, "no-identity");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });

    // Dev mode (no instance.json): identity is optional on the request.
    // Conversation ownership falls back to DEV_IDENTITY (`usr_default`),
    // but the user-message event only stamps `userId` when the request
    // carries an explicit identity — the absence is preserved on the
    // wire as an audit signal that this turn was an anonymous dev call.
    const result = await runtime.chat({ message: "no identity" });

    const convFile = topLevelConvPath(workDir, result.conversationId);
    const content = readFileSync(convFile, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const userEvent = lines
      .slice(1)
      .map((l) => JSON.parse(l))
      .find((e: Record<string, unknown>) => e.type === "user.message");

    expect(userEvent).toBeDefined();
    expect(userEvent.type).toBe("user.message");
    expect(userEvent.userId).toBeUndefined();

    await runtime.shutdown();
  });
});
