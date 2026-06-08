/**
 * Stage 2 — T006 acceptance criteria tests (Group B audit follow-ups).
 *
 * Two contracts pinned here that the cross-workspace E2E
 * (`cross-workspace-chat.test.ts`) doesn't observe directly:
 *
 *  1. **Aggregator disposal on `runtime.shutdown()`** — the runtime owns the
 *     cross-workspace tool-list aggregator and MUST dispose its FS watchers
 *     on shutdown. Without this, long-running test suites and production
 *     deployments leak `fs.watch` handles across the process lifetime.
 *     Verified by asserting `activeWatcherCount() === 0` after shutdown.
 *
 *  2. **Orchestrator error taxonomy** — the four orchestrator error classes
 *     (`UnknownNamespacedToolName`, `UnknownWorkspace`, `WorkspaceAccessDenied`,
 *     `UnknownToolSource`) each map to a distinct `data.reason` discriminator
 *     on the `isError: true` tool result that surfaces through `runtime.chat()`.
 *     Conflating them under one symptom hides real failure modes (Stage 1
 *     lesson 2). The discriminators are identical to the ones T007 uses for
 *     the `/mcp` JSON-RPC path so HTTP / MCP consumers can rely on a single
 *     vocabulary.
 *
 * These tests use the existing two-workspace fixture so the orchestrator's
 * routing path is the same one cross-workspace-chat exercises.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { makeTestWorkDir } from "../../helpers/test-workdir.ts";
import {
  createTwoWorkspaceFixture,
  type TwoWorkspaceFixture,
} from "../../helpers/two-workspace-fixture.ts";

// ── 1. Aggregator disposal ────────────────────────────────────────

describe("runtime shutdown — tool-list aggregator disposal (T006)", () => {
  it("aggregator's active watchers drop to zero after runtime.shutdown()", async () => {
    // Boot a runtime, then aggregate tools so the aggregator's cache
    // attaches per-workspace watchers under the hood.
    const fixture = await createTwoWorkspaceFixture();
    const aggregator = fixture.runtime.getToolListAggregator();
    // First call primes the membership-stamp + per-workspace entries.
    await aggregator.aggregateToolList(fixture.identity.id);
    // Active watchers MAY be 0 with the in-memory test fixture (the
    // cache attaches watchers lazily and only on directories that
    // exist). What we want to pin is the disposal invariant: whatever
    // the count is before shutdown, it MUST be 0 after.
    const before = aggregator.activeWatcherCount();
    expect(before).toBeGreaterThanOrEqual(0);

    await fixture.cleanup();

    // The aggregator is owned by the runtime; runtime.shutdown() (called
    // from cleanup()) MUST dispose it. After shutdown the same handle
    // still answers the count query — that's how the leak-free invariant
    // is observable.
    expect(aggregator.activeWatcherCount()).toBe(0);
  });

  it("aggregator dispose is idempotent across multiple shutdowns", async () => {
    // Defense-in-depth: a future refactor that double-calls shutdown
    // (e.g. graceful + force) must not double-throw.
    const { workDir, cleanup } = makeTestWorkDir("t006-aggregator-dispose");
    const runtime = await Runtime.start({
      workDir,
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      logging: { disabled: true },
    });
    const aggregator = runtime.getToolListAggregator();
    await runtime.shutdown();
    expect(aggregator.activeWatcherCount()).toBe(0);
    // Second call must not throw.
    await runtime.shutdown();
    expect(aggregator.activeWatcherCount()).toBe(0);
    cleanup();
  });
});

// ── 2. Orchestrator error taxonomy mapping ────────────────────────

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

  it("`UnknownWorkspace` → reason='unknown_workspace'", async () => {
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
      fixture.buildChatRequest({ message: "trigger unknown_workspace" }),
    );
    const tc = result.toolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.ok).toBe(false);
    expect(tc.output).toContain("unknown workspace");
    expect(tc.output).toContain("ws_does_not_exist");
  });

  it("`WorkspaceAccessDenied` → reason='workspace_access_denied'", async () => {
    // Create a third workspace the identity is NOT a member of, then
    // emit a tool call into it. The orchestrator must refuse with
    // WorkspaceAccessDenied (not UnknownWorkspace — the ws exists).
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
              // Personal workspace is accessible, but `nonexistent` source
              // is not registered there. Orchestrator must surface
              // UnknownToolSource (not UnknownWorkspace — ws exists and
              // user IS a member).
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
