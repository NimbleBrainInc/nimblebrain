/**
 * Resume rejects a workspace-mismatched focus — the server-side backstop against
 * a client that drifted out of sync (the cross-workspace mis-target).
 *
 * A conversation is sealed to its own workspace (`convWsId`); the runtime always
 * binds a resumed turn there, so this is NOT the data-isolation seam. It's a
 * coherence check: if a resume names a FOCUSED workspace (`X-Workspace-Id` →
 * `request.workspaceId`) that differs from the conversation's own, the client is
 * displaying one workspace while about to resume a conversation from another — a
 * send would land the message where the user isn't looking. `chat()` and
 * `startTurn()` both reject it with `ConversationWorkspaceMismatchError` (→ 409),
 * next to the existing resume membership recheck.
 *
 * Crucially, an identity-level resume that sends NO `X-Workspace-Id` (focus null
 * — embedded / CLI / home callers) is left untouched: the conversation still
 * resolves its own workspace. This pins the reject, the match allow-case, and the
 * header-absent preservation.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationWorkspaceMismatchError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-resume-ws-mismatch-${Date.now()}`);
const WORKSPACE_A = "ws_workspace_a";
const WORKSPACE_B = "ws_workspace_b";

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

async function startRuntime(name: string): Promise<Runtime> {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  return Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });
}

describe("resume rejects a workspace-mismatched focus", () => {
  it("denies chat() resume when the focused workspace differs from the conversation's own", async () => {
    const runtime = await startRuntime("chat-mismatch");
    // The owner is a member of BOTH workspaces — this is not an access failure.
    await provisionTestWorkspace(runtime, WORKSPACE_A, "Alpha");
    await provisionTestWorkspace(runtime, WORKSPACE_B, "Bravo");

    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });

    let thrown: unknown;
    try {
      await runtime.chat({
        message: "resumed while looking at B",
        conversationId: born.conversationId,
        workspaceId: WORKSPACE_B, // focused elsewhere — the mis-target signal
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConversationWorkspaceMismatchError);
    const err = thrown as ConversationWorkspaceMismatchError;
    expect(err.conversationWorkspaceId).toBe(WORKSPACE_A);
    expect(err.requestWorkspaceId).toBe(WORKSPACE_B);
    expect(err.code).toBe("conversation_workspace_mismatch");

    await runtime.shutdown();
  });

  it("denies startTurn() resume on a mismatched focus (before reserving a run)", async () => {
    const runtime = await startRuntime("start-mismatch");
    await provisionTestWorkspace(runtime, WORKSPACE_A, "Alpha");
    await provisionTestWorkspace(runtime, WORKSPACE_B, "Bravo");

    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });

    let thrown: unknown;
    try {
      await runtime.startTurn({
        message: "resumed while looking at B",
        conversationId: born.conversationId,
        workspaceId: WORKSPACE_B,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConversationWorkspaceMismatchError);
    // Rejected before reserving a run — the conversation isn't marked active.
    expect(runtime.isTurnActive(born.conversationId)).toBe(false);

    await runtime.shutdown();
  });

  it("allows resume when the focused workspace matches the conversation's own", async () => {
    const runtime = await startRuntime("chat-match");
    await provisionTestWorkspace(runtime, WORKSPACE_A, "Alpha");

    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });
    const resumed = await runtime.chat({
      message: "still in A",
      conversationId: born.conversationId,
      workspaceId: WORKSPACE_A,
    });
    expect(resumed.conversationId).toBe(born.conversationId);

    await runtime.shutdown();
  });

  it("does NOT gate an identity-level resume that sends no focused workspace", async () => {
    const runtime = await startRuntime("chat-no-header");
    await provisionTestWorkspace(runtime, WORKSPACE_A, "Alpha");

    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });
    // No `workspaceId` (X-Workspace-Id absent — the home / identity surface). The
    // conversation still resolves its own workspace (A); the guard must not fire.
    const resumed = await runtime.chat({
      message: "resumed from home",
      conversationId: born.conversationId,
    });
    expect(resumed.conversationId).toBe(born.conversationId);

    await runtime.shutdown();
  });
});
