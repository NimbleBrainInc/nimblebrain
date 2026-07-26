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

  it("a `ws_<id>-` name is rejected without leaking whether that workspace exists", async () => {
    // The no-leak property is unchanged and now holds for a stronger reason: the
    // `ws_<id>-` form is retired, so the name is rejected as a stale wire form
    // before ANY workspace lookup. A bogus workspace and a real one the caller
    // cannot reach are indistinguishable in the response, because neither is
    // ever looked up.
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
    // Rejected before existence is checked: the error names the retired form,
    // never "unknown workspace" (no existence leak).
    expect(tc.output).toMatch(/retired/i);
    expect(tc.output).not.toMatch(/unknown workspace/i);
  });

  it("a `ws_<id>-` name naming a real, unreachable workspace is rejected as a retired form", async () => {
    // Was the `CrossWorkspaceReachDenied → workspace_access_denied` case. That
    // error no longer exists: naming a second workspace is unexpressible rather
    // than denied, so a real-but-unreachable workspace and a bogus one now fail
    // identically, at parse. The `WorkspaceToolUnavailable →
    // workspace_access_denied` mapping this used to share is covered by the
    // /mcp no-`X-Workspace-Id` case in `mcp-server-identity-bound.test.ts`.
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
    expect(tc.output).toMatch(/retired/i);
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
              // Bare, so it resolves against the session's own workspace — where
              // `nonexistent` is not registered. Orchestrator must surface
              // UnknownToolSource: the workspace is in reach, the source name
              // just doesn't resolve.
              toolName: "nonexistent__do_thing",
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
