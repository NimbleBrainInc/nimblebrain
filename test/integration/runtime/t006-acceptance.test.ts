/**
 * Orchestrator error-taxonomy tests.
 *
 * Each orchestrator error class surfaces a distinct `data.reason` discriminator
 * on the `isError: true` tool result that flows through `runtime.chat()`:
 * `invalid_tool_name`, `workspace_access_denied` (the wall — a call to any
 * workspace other than the session's is denied), and `unknown_tool_source`.
 * Conflating them under one symptom hides real failure modes. These tests use
 * the two-workspace fixture so the routing path matches production.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  createTwoWorkspaceFixture,
  type TwoWorkspaceFixture,
} from "../../helpers/two-workspace-fixture.ts";

// ── Orchestrator error taxonomy mapping ────────────────────────

describe("runtime.chat — orchestrator error taxonomy (T006)", () => {
  let fixture: TwoWorkspaceFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = null;
    }
  });

  /**
   * Each test pins exactly one of the four orchestrator error classes by
   * scripting the echo model to emit a tool call that triggers that error
   * class, then inspects the resulting `tool_call.ok = false` record's
   * `output` string for the discriminator.
   *
   * Why look at the chat result's `toolCalls[]` rather than the raw
   * `tool.done` event payload: `result.toolCalls[].output` is the
   * serialized `isError: true` result, which carries the structured
   * `reason` field on its `structuredContent`. The event payload
   * `tool.done.data` doesn't include `structuredContent` separately —
   * it's already collapsed into the result by the time the engine
   * builds the chat result.
   */

  it("`UnknownNamespacedToolName` → reason='invalid_tool_name'", async () => {
    fixture = await createTwoWorkspaceFixture({
      modelResponses: [
        {
          toolCalls: [
            {
              toolCallId: "call_invalid_name",
              // A malformed `ws_`-prefixed name: looks like a workspace
              // attempt but fails WORKSPACE_ID_RE, so the parser throws
              // UnknownNamespacedToolName. (A *bare* name like
              // `bare_tool_no_prefix` is now global scope, not a parse
              // error — see the global-scope cases in namespace.test.ts.)
              toolName: "ws_BAD!-foo__bar",
              input: "{}",
            },
          ],
        },
        { text: "done" },
      ],
    });
    const result = await fixture.runtime.chat(
      fixture.buildChatRequest({ message: "trigger invalid_tool_name" }),
    );
    const tc = result.toolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.ok).toBe(false);
    expect(tc.output).toContain("invalid tool name");
  });

  it("the wall denies a non-focused workspace (even a non-existent one) without leaking unknown_workspace", async () => {
    // A session is bounded to its one workspace. A call to any other workspace
    // is denied by the wall BEFORE existence is checked, so a bogus workspace
    // name yields the same access-denied outcome as any other-workspace call —
    // no information leak about whether the workspace exists.
    fixture = await createTwoWorkspaceFixture({
      modelResponses: [
        {
          toolCalls: [
            {
              toolCallId: "call_unknown_ws",
              toolName: "ws_does_not_exist-crm__search",
              input: "{}",
            },
          ],
        },
        { text: "done" },
      ],
    });
    const result = await fixture.runtime.chat(
      fixture.buildChatRequest({ message: "trigger wall denial" }),
    );
    const tc = result.toolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.ok).toBe(false);
    // Walled before existence is checked: the denial names the out-of-reach
    // workspace, never "unknown workspace" (no existence leak).
    expect(tc.output).toMatch(/not a member|denied|access/i);
    expect(tc.output).toContain("ws_does_not_exist");
    expect(tc.output).not.toMatch(/unknown workspace/i);
  });

  it("`WorkspaceAccessDenied` → reason='workspace_access_denied'", async () => {
    // Create a third workspace the identity is NOT a member of, then
    // emit a tool call into it. The wall refuses any reach outside the
    // session's workspace with workspace_access_denied (here via
    // CrossWorkspaceReachDenied — the stranger ws exists, it's just not ours).
    fixture = await createTwoWorkspaceFixture();
    const wsStore = fixture.runtime.getWorkspaceStore();
    const stranger = await wsStore.create("Stranger Workspace", "stranger");
    await fixture.cleanup();

    // Re-fixture with a scripted model targeting the stranger workspace.
    fixture = await createTwoWorkspaceFixture({
      modelResponses: [
        {
          toolCalls: [
            {
              toolCallId: "call_denied",
              toolName: `${stranger.id}-crm__search`,
              input: "{}",
            },
          ],
        },
        { text: "done" },
      ],
    });
    // The second fixture create()s a fresh workspace store under a new
    // temp workDir; ensure the stranger workspace exists in the live
    // fixture's store too (same id).
    await fixture.runtime
      .getWorkspaceStore()
      .create("Stranger Workspace", stranger.id.slice(3));

    const result = await fixture.runtime.chat(
      fixture.buildChatRequest({ message: "trigger workspace_access_denied" }),
    );
    const tc = result.toolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.ok).toBe(false);
    expect(tc.output).toMatch(/not a member|access/i);
  });

  it("`UnknownToolSource` → reason='unknown_tool_source'", async () => {
    // Target a workspace the identity CAN access but with a source name
    // that isn't registered in that workspace's `ToolRegistry`.
    fixture = await createTwoWorkspaceFixture({
      modelResponses: [
        {
          toolCalls: [
            {
              toolCallId: "call_unknown_source",
              // Personal is the session's workspace (the wall lets it
              // through), but `nonexistent` source is not registered there.
              // Orchestrator must surface UnknownToolSource — the ws is in
              // reach, the source name just doesn't resolve.
              toolName: `${fixture?.personal.id ?? "ws_user_x"}-nonexistent__do_thing`,
              input: "{}",
            },
          ],
        },
        { text: "done" },
      ],
    });
    // Update the model response to use the LIVE fixture's personal ws id.
    // (We had to script BEFORE the fixture was rebooted; the script just
    // referenced a fallback. Re-fixture with the real id.)
    const personalId = fixture.personal.id;
    await fixture.cleanup();
    fixture = await createTwoWorkspaceFixture({
      modelResponses: [
        {
          toolCalls: [
            {
              toolCallId: "call_unknown_source",
              toolName: `${personalId}-nonexistent__do_thing`,
              input: "{}",
            },
          ],
        },
        { text: "done" },
      ],
    });

    const result = await fixture.runtime.chat(
      fixture.buildChatRequest({ message: "trigger unknown_tool_source" }),
    );
    const tc = result.toolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.ok).toBe(false);
    expect(tc.output).toMatch(/no source|nonexistent/i);
  });
});
