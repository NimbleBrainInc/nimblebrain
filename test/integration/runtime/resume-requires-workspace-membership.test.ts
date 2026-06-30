/**
 * Resume requires CURRENT membership of the conversation's workspace.
 *
 * A conversation is sealed to its workspace (#584): on resume its tools/skills/
 * apps resolve in `convWsId`. So resuming as a non-member would grant that
 * workspace's tools to someone offboarded from it. Ownership is necessary but not
 * sufficient — both `chat()` and `startTurn()` re-check membership on resume and
 * throw `ConversationWorkspaceAccessDeniedError`.
 *
 * Reads stay owner-gated (covered elsewhere); this pins the active/resume path,
 * the current-member allow case, and the personal-workspace exemption.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { ConversationWorkspaceAccessDeniedError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-resume-membership-${Date.now()}`);
const WORKSPACE_A = "ws_workspace_a";
const OWNER = DEV_IDENTITY.id;

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

describe("resume requires current membership of the conversation's workspace", () => {
  it("denies chat() resume after the owner is removed from the shared workspace", async () => {
    const runtime = await startRuntime("chat-removed");
    await provisionTestWorkspace(runtime, WORKSPACE_A, "Alpha");

    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });
    await runtime.getWorkspaceStore().removeMember(WORKSPACE_A, OWNER);

    let thrown: unknown;
    try {
      await runtime.chat({ message: "still here?", conversationId: born.conversationId });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConversationWorkspaceAccessDeniedError);
    expect((thrown as ConversationWorkspaceAccessDeniedError).conversationWorkspaceId).toBe(
      WORKSPACE_A,
    );

    await runtime.shutdown();
  });

  it("denies startTurn() resume after the owner is removed (before reserving a run)", async () => {
    const runtime = await startRuntime("start-removed");
    await provisionTestWorkspace(runtime, WORKSPACE_A, "Alpha");

    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });
    await runtime.getWorkspaceStore().removeMember(WORKSPACE_A, OWNER);

    let thrown: unknown;
    try {
      await runtime.startTurn({ message: "still here?", conversationId: born.conversationId });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConversationWorkspaceAccessDeniedError);

    await runtime.shutdown();
  });

  it("allows resume while the owner is still a member", async () => {
    const runtime = await startRuntime("still-member");
    await provisionTestWorkspace(runtime, WORKSPACE_A, "Alpha");

    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });
    // No removal — Alice stays a member.
    const resumed = await runtime.chat({
      message: "still here",
      conversationId: born.conversationId,
      workspaceId: WORKSPACE_A,
    });
    expect(resumed.conversationId).toBe(born.conversationId);

    await runtime.shutdown();
  });

  it("does not gate a personal-workspace conversation (sole-member by construction)", async () => {
    const runtime = await startRuntime("personal");

    // Born unfocused → personal workspace; resume must not be gated.
    const born = await runtime.chat({ message: "hello from home" });
    const resumed = await runtime.chat({
      message: "still here",
      conversationId: born.conversationId,
    });
    expect(resumed.conversationId).toBe(born.conversationId);

    await runtime.shutdown();
  });
});
