/**
 * The run-start door holds the membership gate — once, for every trigger.
 *
 * ADR-0007's invariant is that the workspace a run acts in is membership-
 * validated at session establishment on EVERY door. It used to hold because
 * each door re-implemented it: `chat()` gated a resume, `executeTask()` gated an
 * automation run, and nothing tied the two together. `startRun` is now the only
 * place a run is established, so the check has one call site and the invariant
 * holds by construction.
 *
 * This test pins that: a removed member's conversation resume and the same
 * member's automation run are refused by the SAME code path (both stacks name
 * `startRun`), while each keeps the outcome its caller's contract needs —
 * `conversation_access_denied` (the 403 a person sees) and
 * `workspace_membership_revoked` (the code the scheduler records as SKIPPED, so
 * the automation self-heals if the owner is re-added).
 *
 * It also pins that a refused run touches nothing: the gate runs before the
 * turn's user message is written, so a rejected resume leaves the conversation
 * log exactly as it was.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import {
  ConversationWorkspaceAccessDeniedError,
  WorkspaceMembershipRevokedError,
} from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-run-door-gate-${Date.now()}`);
const SHARED_WS = "ws_shared_alpha";
const OWNER = DEV_IDENTITY.id;

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

/** Capture whatever a call threw, or `null` if it resolved. */
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}

describe("the run-start door gates workspace membership for every trigger", () => {
  it("refuses a removed member's chat resume and automation run through one gate", async () => {
    const workDir = join(testDir, "one-gate");
    mkdirSync(workDir, { recursive: true });
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, SHARED_WS, "Alpha");

    // Both doors work while the owner is a member.
    const opened = await runtime.chat({ message: "first turn", workspaceId: SHARED_WS });
    const resumed = await runtime.chat({
      message: "second turn",
      workspaceId: SHARED_WS,
      conversationId: opened.conversationId,
    });
    expect(resumed.conversationId).toBe(opened.conversationId);
    const ranWhileMember = await runtime.executeTask({
      prompt: "do the thing",
      workspaceId: SHARED_WS,
    });
    expect(ranWhileMember.output).toBeDefined();

    // The conversation as it stands before the offboarding.
    const store = runtime.workspaceConversationStore(SHARED_WS, OWNER);
    const conversation = await store.load(opened.conversationId);
    expect(conversation).not.toBeNull();
    const messagesBefore = (await store.history(conversation!)).length;

    // Offboard the owner from the shared workspace.
    await runtime.getWorkspaceStore().removeMember(SHARED_WS, OWNER);

    const chatRefusal = await refusal(() =>
      runtime.chat({
        message: "third turn",
        workspaceId: SHARED_WS,
        conversationId: opened.conversationId,
      }),
    );
    const taskRefusal = await refusal(() =>
      runtime.executeTask({ prompt: "do the thing", workspaceId: SHARED_WS }),
    );

    // Each door keeps the outcome its caller's contract needs.
    expect(chatRefusal).toBeInstanceOf(ConversationWorkspaceAccessDeniedError);
    expect((chatRefusal as ConversationWorkspaceAccessDeniedError).code).toBe(
      "conversation_access_denied",
    );
    expect((chatRefusal as ConversationWorkspaceAccessDeniedError).conversationWorkspaceId).toBe(
      SHARED_WS,
    );

    expect(taskRefusal).toBeInstanceOf(WorkspaceMembershipRevokedError);
    expect((taskRefusal as WorkspaceMembershipRevokedError).code).toBe(
      "workspace_membership_revoked",
    );
    expect((taskRefusal as WorkspaceMembershipRevokedError).workspaceId).toBe(SHARED_WS);

    // …and both were refused by the same code path. Asserting on the stack is
    // the only way to say "one gate" rather than "two gates that agree" — which
    // is exactly the property that decayed before, since two agreeing gates look
    // identical from the outside right up until one of them is forgotten.
    expect((chatRefusal as Error).stack).toContain("startRun");
    expect((taskRefusal as Error).stack).toContain("startRun");

    // The gate runs before the run writes anything: the refused resume left the
    // conversation log untouched.
    expect((await store.history(conversation!)).length).toBe(messagesBefore);

    await runtime.shutdown();
  });
});
