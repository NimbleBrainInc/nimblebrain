/**
 * Stage 2 — Cross-workspace chat E2E (T001, load-bearing).
 *
 * This test pins the single Stage 2 contract that every subsequent task
 * must keep green:
 *
 *   **A single chat invokes `ws_helix/<tool>` then `ws_user_<id>/<tool>` in
 *   turn, and each call lands in its originating workspace's bundle
 *   subprocess and audit context — never the other.**
 *
 * Authored BEFORE the orchestrator exists. The full suite is parked behind
 * a single grep-able skip marker (`SKIP_UNTIL_T006`) so CI stays green until
 * T006 wires `src/orchestrator/` into `runtime.chat`. T006's Acceptance
 * Criteria explicitly include "remove the SKIP_UNTIL_T006 guard from
 * test/integration/cross-workspace-chat.test.ts" — a single-edit flip.
 *
 * Don't add new skip markers. Don't promote the marker into a config flag.
 * The point is one obvious string a reviewer can grep when auditing what
 * test coverage the orchestrator gates on.
 *
 * The five cases below correspond 1:1 to the cross-workspace E2E test
 * plan and each names the failure mode it pins.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { EchoModelOptions } from "../helpers/echo-model.ts";
import {
  createTwoWorkspaceFixture,
  type TwoWorkspaceFixture,
} from "../helpers/two-workspace-fixture.ts";

// ── Skip marker (grep-able) ────────────────────────────────────────

/**
 * Grep this exact string to find the single flip-the-suite-on edit T006
 * needs to make. Removing this constant + the `if (SKIP_UNTIL_T006)` block
 * below is all T006 has to do here.
 *
 * Why a marker constant vs `it.skip(...)` per case: the suite has five
 * cases, several with nontrivial assertion bodies that the audit needs to
 * read in full. Wrapping each in `it.skip` would either bury the cases
 * one-skip-decorator-deep or require five identical edits. A single guard
 * at the top — visible by `grep -n SKIP_UNTIL_T006` across the repo —
 * makes the lifecycle a single-line change.
 */
const SKIP_UNTIL_T006 = false;

// Each test is wrapped in `it.if(!SKIP_UNTIL_T006)(...)`. When T006 flips
// the const to `false`, all five become real `it(...)` cases. Bun's
// `it.if` is the supported "conditional skip" primitive (mirrors Jest);
// when the predicate is false the case is reported as skipped, not as a
// passing pseudo-test.

// ── Test-suite-local helpers ──────────────────────────────────────

/**
 * Stage 2 fixture wrinkle: tool-call `toolName`s in the scripted echo
 * model must be the namespaced canonical names, which are themselves
 * derived from the fixture's workspace ids. So the model has to be
 * scripted AFTER the fixture is built. This helper boots a fixture, then
 * reboots it with the model wired to the per-test response script.
 *
 * The double-boot is the price of keeping the fixture's option surface
 * stateless (no setter-after-construction for the model). Each test is
 * cheap (in-process MCP, no subprocess), so the overhead is negligible
 * — and per-test isolation is what we want anyway.
 */
async function bootFixtureWithScript(
  buildResponses: (handle: TwoWorkspaceFixture) => EchoModelOptions["responses"],
): Promise<TwoWorkspaceFixture> {
  // First fixture: only used to read the qualified tool names from the
  // canonical wsId derivation (no model calls happen here).
  const probe = await createTwoWorkspaceFixture();
  const responses = buildResponses(probe);
  await probe.cleanup();

  // Second fixture: the one the test actually exercises, with model
  // scripted on the qualified names from the first.
  return createTwoWorkspaceFixture({ modelResponses: responses });
}

/**
 * Returns every `tool.done` event captured during the fixture's lifetime.
 * The post-T006 runtime will stamp `workspaceId` onto every tool.done
 * payload; case 3 reads that field directly.
 */
function toolDoneEvents(fixture: TwoWorkspaceFixture): Array<Record<string, unknown>> {
  return fixture.events.captured
    .filter((e) => e.type === "tool.done")
    .map((e) => e.data);
}

// ── Suite ─────────────────────────────────────────────────────────

describe("cross-workspace chat (Stage 2 contract — T001)", () => {
  let fixture: TwoWorkspaceFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = null;
    }
  });

  // ── 1. Happy path ───────────────────────────────────────────────
  //
  // Pins: "the agentic loop can interleave two workspaces' tools in one
  // conversation." A failure here means cross-workspace dispatch is
  // simply not wired.
  it.if(!SKIP_UNTIL_T006)(
    "happy path — two namespaced tool calls in one chat increment each workspace's counter exactly once",
    async () => {
      fixture = await bootFixtureWithScript((f) => [
        {
          toolCalls: [
            {
              toolCallId: "call_shared",
              toolName: f.shared.qualifiedToolName,
              input: JSON.stringify({ echo: "shared-echo" }),
            },
          ],
        },
        {
          toolCalls: [
            {
              toolCallId: "call_personal",
              toolName: f.personal.qualifiedToolName,
              input: JSON.stringify({ echo: "personal-echo" }),
            },
          ],
        },
        { text: "done" },
      ]);

      const result = await fixture.runtime.chat(
        fixture.buildChatRequest({ message: "exercise both workspaces" }),
      );

      // Both per-source counters incremented exactly once.
      expect(fixture.shared.callCount()).toBe(1);
      expect(fixture.personal.callCount()).toBe(1);

      // Run completed and produced both tool calls (canonical
      // namespaced names round-trip into `ChatResult.toolCalls`).
      expect(result.toolCalls).toHaveLength(2);
      const names = result.toolCalls.map((tc) => tc.name);
      expect(names).toContain(fixture.shared.qualifiedToolName);
      expect(names).toContain(fixture.personal.qualifiedToolName);

      // Output strings differ (each source stamps its own name).
      const outputs = result.toolCalls.map((tc) => tc.output);
      expect(new Set(outputs).size).toBe(2);
      expect(outputs.some((o) => o.includes(`[${fixture!.shared.sourceName}]`))).toBe(true);
      expect(outputs.some((o) => o.includes(`[${fixture!.personal.sourceName}]`))).toBe(true);

      // Conversation JSONL records the namespaced canonical names
      // verbatim — Stage 2 stores the raw `ws_<id>/<inner>` form per
      // Q2 of STAGE_2_DESIGN_DECISIONS.md (render friendly on the fly,
      // never lossy on disk).
      const convPath = join(fixture.workDir, "conversations", `${result.conversationId}.jsonl`);
      expect((await stat(convPath)).isFile()).toBe(true);
      const jsonl = await Bun.file(convPath).text();
      expect(jsonl).toContain(fixture.shared.qualifiedToolName);
      expect(jsonl).toContain(fixture.personal.qualifiedToolName);
    },
  );

  // ── 2. Topology check (Stage 1 lesson 1) ────────────────────────
  //
  // Pins: "a `ws_helix/...` call MUST NOT increment the personal
  // workspace's counter."
  //
  // The naive failure mode: an implementation that resolves every
  // namespaced call to "the current workspace" passes any output-only
  // assertion (the echo string would still come back) — but the per-
  // source counter on the WRONG workspace would tick up, and the right
  // workspace's would stay at zero. This is the structural guard the
  // happy path can't provide.
  it.if(!SKIP_UNTIL_T006)(
    "topology — ws_helix call increments only the shared source's counter (not personal)",
    async () => {
      fixture = await bootFixtureWithScript((f) => [
        {
          toolCalls: [
            {
              toolCallId: "call_shared_only",
              toolName: f.shared.qualifiedToolName,
              input: JSON.stringify({ echo: "shared-only" }),
            },
          ],
        },
        { text: "done" },
      ]);

      await fixture.runtime.chat(
        fixture.buildChatRequest({ message: "exercise only shared workspace" }),
      );

      // The structural assertion: shared went up, personal stayed flat.
      // Reversing dispatch (everything goes to personal) would invert
      // these two numbers and the case would fail loudly.
      expect(fixture.shared.callCount()).toBe(1);
      expect(fixture.personal.callCount()).toBe(0);
    },
  );

  // ── 3. Audit attribution (Stage 1 lesson 2) ─────────────────────
  //
  // Pins: "every `tool.done` event carries the originating
  // `workspaceId` matching the namespace prefix."
  //
  // The naive failure mode: an implementation that stamps the
  // conversation's metadata `workspaceId` (or the request's) onto every
  // event would pass case 2 (counters still right) but every audit
  // entry would point at the same workspace. The audit field is the
  // independent observation channel that catches this.
  it.if(!SKIP_UNTIL_T006)(
    "audit — each tool.done event's workspaceId matches its namespace prefix",
    async () => {
      fixture = await bootFixtureWithScript((f) => [
        {
          toolCalls: [
            {
              toolCallId: "call_shared",
              toolName: f.shared.qualifiedToolName,
              input: JSON.stringify({ echo: "for-audit-shared" }),
            },
          ],
        },
        {
          toolCalls: [
            {
              toolCallId: "call_personal",
              toolName: f.personal.qualifiedToolName,
              input: JSON.stringify({ echo: "for-audit-personal" }),
            },
          ],
        },
        { text: "done" },
      ]);

      await fixture.runtime.chat(
        fixture.buildChatRequest({ message: "audit both workspaces" }),
      );

      const events = toolDoneEvents(fixture);
      const sharedEvent = events.find((e) => e.id === "call_shared");
      const personalEvent = events.find((e) => e.id === "call_personal");
      expect(sharedEvent).toBeDefined();
      expect(personalEvent).toBeDefined();

      // The post-T006 contract: `tool.done.data.workspaceId` is the
      // resolved-from-namespace workspace. Today (pre-T006) this field
      // is absent, which is exactly why this suite is gated by
      // SKIP_UNTIL_T006.
      expect(sharedEvent?.workspaceId).toBe(fixture.shared.id);
      expect(personalEvent?.workspaceId).toBe(fixture.personal.id);

      // Cross-check: the workspaceId must NOT match the OTHER workspace
      // (defends against the "stamp every event with the conversation's
      // workspaceId" failure mode).
      expect(sharedEvent?.workspaceId).not.toBe(fixture.personal.id);
      expect(personalEvent?.workspaceId).not.toBe(fixture.shared.id);
    },
  );

  // ── 4. Strict invariant (Stage 1 lesson 3) ──────────────────────
  //
  // Pins: "an un-namespaced tool call name throws a structured error
  // from the orchestrator — no fallback to current workspace."
  //
  // The naive failure mode: defensive defaults that route any
  // un-prefixed name to "the request's workspace" make a class of LLM
  // mistakes silently succeed, with results landing in a workspace the
  // user didn't intend. The contract is fail-loud.
  it.if(!SKIP_UNTIL_T006)(
    "strict — an un-namespaced tool call surfaces a structured error and is NOT routed anywhere",
    async () => {
      fixture = await bootFixtureWithScript((f) => [
        {
          toolCalls: [
            {
              toolCallId: "call_unprefixed",
              // No `ws_<id>/` prefix — orchestrator MUST refuse.
              toolName: `${f.shared.sourceName}__${f.shared.toolName}`,
              input: JSON.stringify({ echo: "no-prefix" }),
            },
          ],
        },
        { text: "done" },
      ]);

      const result = await fixture.runtime.chat(
        fixture.buildChatRequest({ message: "send un-namespaced call" }),
      );

      // Structured tool error came back (engine surfaces orchestrator
      // errors as `ok: false` tool results).
      expect(result.toolCalls).toHaveLength(1);
      const tc = result.toolCalls[0];
      expect(tc).toBeDefined();
      if (!tc) return; // narrow for TS
      expect(tc.ok).toBe(false);

      // Bare name (no `ws_<id>-`) → global scope. A bare workspace-app
      // tool isn't a global tool, so it's refused (pre-W3 as "global not
      // routable"; post-W3 as "unknown global source"). Either way the
      // error names the failure mode, not a workspace — anchoring a future
      // search against ever regressing into "fall back to current
      // workspace" silent routing.
      expect(tc.output).toMatch(/global|namespac|workspace/i);

      // Critical: neither workspace's source was called.
      expect(fixture.shared.callCount()).toBe(0);
      expect(fixture.personal.callCount()).toBe(0);
    },
  );

  // ── 5. Unknown workspace prefix ─────────────────────────────────
  //
  // Pins: "`ws_doesnotexist/foo` surfaces a structured tool error and
  // does NOT coerce to the user's personal workspace."
  //
  // The naive failure mode: an "if wsId not found, default to personal"
  // resolver makes cross-tenant accidents indistinguishable from
  // intentional personal-workspace use. The contract: unknown prefix
  // → structured error, no dispatch anywhere.
  it.if(!SKIP_UNTIL_T006)(
    "unknown prefix — ws_doesnotexist-foo surfaces a structured error, does NOT fall back to personal workspace",
    async () => {
      fixture = await bootFixtureWithScript(() => [
        {
          toolCalls: [
            {
              toolCallId: "call_bogus_ws",
              toolName: "ws_doesnotexist-foo__bar",
              input: JSON.stringify({ echo: "bogus" }),
            },
          ],
        },
        { text: "done" },
      ]);

      const result = await fixture.runtime.chat(
        fixture.buildChatRequest({ message: "send call into unknown workspace" }),
      );

      expect(result.toolCalls).toHaveLength(1);
      const tc = result.toolCalls[0];
      expect(tc).toBeDefined();
      if (!tc) return;
      expect(tc.ok).toBe(false);

      // Error must name the unknown workspace explicitly — defends
      // against a future regression where the orchestrator silently
      // routes unknown prefixes to a default.
      expect(tc.output).toMatch(/ws_doesnotexist/);

      // Neither workspace got the call.
      expect(fixture.shared.callCount()).toBe(0);
      expect(fixture.personal.callCount()).toBe(0);
    },
  );

  // Sanity case: at least one assertion always runs so Bun reports the
  // file as exercised even when the suite is fully gated. Without this,
  // a future refactor that silently broke the test-discovery layer
  // would appear as a clean run.
  it("skip-guard self-check — SKIP_UNTIL_T006 controls the suite", () => {
    expect(typeof SKIP_UNTIL_T006).toBe("boolean");
  });
});
