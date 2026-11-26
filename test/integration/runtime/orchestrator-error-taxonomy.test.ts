/**
 * What the chat door answers for names the orchestrator would reject.
 *
 * Each orchestrator error class carries a distinct `data.reason` discriminator
 * (`invalid_tool_name`, `workspace_access_denied`, `unknown_tool_source`),
 * pinned at the router in `test/unit/orchestrator/route-error-mapping.test.ts`.
 * On the chat door none of these names is in the run's listing, so the engine
 * refuses each before routing, with one answer whatever the name addresses:
 * no workspace is looked up, so nothing about one leaks. These tests use the
 * two-workspace fixture so the routing path matches production.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { seedWorkspace } from "../../helpers/test-workspace.ts";
import {
  createTwoWorkspaceFixture,
  type TwoWorkspaceFixture,
} from "../../helpers/two-workspace-fixture.ts";

// ── Orchestrator error taxonomy mapping ────────────────────────

describe("runtime.chat — orchestrator error taxonomy", () => {
  let fixture: TwoWorkspaceFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = null;
    }
  });

  const UNLISTED = "not in this run's tool list";

  /**
   * Each test scripts the echo model to emit a tool call that one orchestrator
   * error class would reject, then inspects the resulting `tool_call.ok =
   * false` record's `output`.
   */

  it("a malformed `ws_` name is refused before routing", async () => {
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
    expect(tc.output).toContain(UNLISTED);
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
              toolName: "ws_002cbcedbb32d4b3-crm__search",
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
    // Refused before existence is checked: never "unknown workspace" (no existence leak).
    expect(tc.output).toBe(
      `ws_002cbcedbb32d4b3-crm__search is not available to the agent: it is ${UNLISTED}. Use nb__search to find the tools you can call; a tool whose connector is reconnecting is listed again on a later step.`,
    );
  });

  it("a `ws_<id>-` name naming a real, unreachable workspace is refused the same way", async () => {
    // Naming a second workspace is unexpressible, so a real-but-unreachable
    // workspace and a bogus one fail identically, at parse — no lookup, no leak.
    // The `WorkspaceToolUnavailable → workspace_access_denied` mapping is covered
    // in `test/unit/orchestrator/route-error-mapping.test.ts`.
    fixture = await createTwoWorkspaceFixture();
    const wsStore = fixture.runtime.getWorkspaceStore();
    const stranger = await wsStore.create("Stranger Workspace");
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
    await seedWorkspace(fixture.runtime.getWorkspaceStore(), stranger.id, {
      name: "Stranger Workspace",
    });

    const result = await fixture.runtime.chat(
      fixture.buildChatRequest({ message: "trigger workspace_access_denied" }),
    );
    const tc = result.toolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.ok).toBe(false);
    expect(tc.output).toContain(UNLISTED);
    expect(tc.output).not.toMatch(/unknown workspace/i);
  });

  it("a name whose source is not registered is refused before routing", async () => {
    // Target a workspace the identity CAN access but with a source name
    // that isn't registered in that workspace's `ToolRegistry`.
    fixture = await createTwoWorkspaceFixture({
      modelResponses: [
        {
          toolCalls: [
            {
              toolCallId: "call_unknown_source",
              // Bare, so it resolves against the session's own workspace — where
              // `nonexistent` is not registered, so the run's listing has no
              // such tool.
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
    expect(tc.output).toContain(UNLISTED);
  });
});
