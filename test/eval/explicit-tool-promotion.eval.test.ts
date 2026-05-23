/**
 * Eval: Explicit Tool Promotion (nb__manage_tools)
 *
 * Validates the explicit promotion workflow end-to-end against a real LLM:
 *   nb__search → nb__manage_tools({ add }) → call the promoted tool.
 *
 * Specifically falsifies the assumptions behind shipping nb__manage_tools
 * as a single batch primitive (vs. the rejected verb-pair / single-item
 * shapes):
 *
 *   A1. Models will batch multiple discovered tools into a single
 *       nb__manage_tools.add call instead of N round-trips.
 *   A2. Models emit valid { add: [...] } shapes — not malformed arrays
 *       or stringified JSON.
 *   A3. Models follow the bootstrap workflow (search → manage_tools → call)
 *       rather than guessing tool names.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test test/eval/explicit-tool-promotion.eval.test.ts
 *
 * These tests call a real LLM and cost real money. They are NOT included
 * in `bun run test` or `bun run verify`.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { runEval, shutdownEvalRuntime, assertSearchedFor } from "./helpers.ts";

afterAll(async () => {
  await shutdownEvalRuntime();
});

/**
 * Assert that nb__manage_tools was called with an `add` array containing
 * at least one of the expected tool names. Reports the actual calls when
 * the assertion fails so eval diffs are debuggable.
 */
function assertManageToolsAdded(
  result: { toolCalls: Array<{ name: string; input: Record<string, unknown> }> },
  expectedAny: string[],
): void {
  const manageCalls = result.toolCalls.filter((tc) => tc.name === "nb__manage_tools");
  if (manageCalls.length === 0) {
    const seen = result.toolCalls.map((tc) => tc.name).join(", ") || "(none)";
    throw new Error(
      `Expected nb__manage_tools to be called. Tools called: ${seen}`,
    );
  }
  const allAdds = manageCalls.flatMap((tc) => {
    const add = tc.input.add;
    return Array.isArray(add) ? (add as unknown[]).map(String) : [];
  });
  const matched = expectedAny.find((name) => allAdds.includes(name));
  if (!matched) {
    throw new Error(
      `Expected nb__manage_tools.add to contain one of [${expectedAny.join(", ")}]. ` +
        `Saw add lists: ${manageCalls.map((tc) => JSON.stringify(tc.input.add)).join(" | ")}`,
    );
  }
}

describe("explicit tool promotion workflow", () => {
  // -----------------------------------------------------------------------
  // A1 / A2 / A3 — single-tool happy path: search → manage_tools → call
  // -----------------------------------------------------------------------

  describe("single-tool happy path", () => {
    it("files: discovers, promotes, and calls a files tool", async () => {
      const result = await runEval("list my files");

      // A3: search-first
      assertSearchedFor(result, "files");

      // A1+A2: well-formed manage_tools call adding a files-source tool
      assertManageToolsAdded(result, [
        "files__list",
        "files__search",
      ]);

      // End-to-end: the discovered tool actually runs
      const calledFilesList = result.toolCalls.some((tc) =>
        tc.name.startsWith("files__"),
      );
      expect(calledFilesList).toBe(true);
    }, 60_000);

    it("conversations: discovers, promotes, and calls a conversations tool", async () => {
      const result = await runEval("show me my recent conversations");

      assertSearchedFor(result, "conversations");
      assertManageToolsAdded(result, [
        "conversations__list",
        "conversations__search",
      ]);

      const calledConv = result.toolCalls.some((tc) =>
        tc.name.startsWith("conversations__"),
      );
      expect(calledConv).toBe(true);
    }, 60_000);
  });

  // -----------------------------------------------------------------------
  // A1 — batching: multiple tools in one manage_tools call
  // -----------------------------------------------------------------------

  describe("batching", () => {
    it("multi-domain: batches add into one manage_tools call when possible", async () => {
      // Spans two platform sources. The win condition is that the agent
      // emits a SINGLE nb__manage_tools call with multiple items in `add`,
      // rather than N sequential single-item calls (which would defeat the
      // round-trip motivation for choosing a batch shape).
      const result = await runEval(
        "list my files AND show me recent conversations — both, in the same response",
      );

      const manageCalls = result.toolCalls.filter((tc) => tc.name === "nb__manage_tools");
      expect(manageCalls.length).toBeGreaterThanOrEqual(1);

      // The "ideal" outcome: one call with both adds. Acceptable: any single
      // call adds 2+ tools across sources. Failing: every call adds exactly 1.
      const maxBatchSize = Math.max(
        ...manageCalls.map((tc) =>
          Array.isArray(tc.input.add) ? (tc.input.add as unknown[]).length : 0,
        ),
        0,
      );
      expect(maxBatchSize).toBeGreaterThanOrEqual(2);
    }, 90_000);
  });

  // -----------------------------------------------------------------------
  // A2 — schema discipline: no malformed arguments
  // -----------------------------------------------------------------------

  describe("argument validity", () => {
    it("never emits a malformed manage_tools call (string-encoded array)", async () => {
      // Anthropic models historically string-encode array arguments under
      // some prompt conditions. The TypeBox schema rejects non-arrays at
      // the validator, but if it happens we want the eval to surface it.
      const result = await runEval("list my files please");
      const manageCalls = result.toolCalls.filter((tc) => tc.name === "nb__manage_tools");

      for (const tc of manageCalls) {
        if (tc.input.add !== undefined) {
          expect(Array.isArray(tc.input.add)).toBe(true);
        }
        if (tc.input.remove !== undefined) {
          expect(Array.isArray(tc.input.remove)).toBe(true);
        }
      }
    }, 60_000);
  });

  // -----------------------------------------------------------------------
  // Release discipline — verifies the softened "default to retain" guidance
  // -----------------------------------------------------------------------

  describe("release discipline", () => {
    it("does not release tools after a single use (default to retain)", async () => {
      // The bootstrap skill says "default to retain — only release on a
      // clear domain switch." A single-tool single-use task should not
      // emit a release. If this fails, models are over-releasing and the
      // softened guidance isn't holding.
      const result = await runEval("list my files");

      const releases = result.toolCalls.filter(
        (tc) =>
          tc.name === "nb__manage_tools" &&
          Array.isArray(tc.input.remove) &&
          (tc.input.remove as unknown[]).length > 0,
      );
      expect(releases).toHaveLength(0);
    }, 60_000);
  });

  // -----------------------------------------------------------------------
  // Negative case — no spurious manage_tools for tools already advertised
  // -----------------------------------------------------------------------

  describe("negative cases", () => {
    it("does not call manage_tools for tools already in the direct list", async () => {
      // nb__search is always direct. Asking the agent to search shouldn't
      // trigger a redundant manage_tools call to "promote" it.
      const result = await runEval("search for installed bundles");

      const promotedSearch = result.toolCalls.some(
        (tc) =>
          tc.name === "nb__manage_tools" &&
          Array.isArray(tc.input.add) &&
          (tc.input.add as unknown[]).includes("nb__search"),
      );
      expect(promotedSearch).toBe(false);
    }, 60_000);
  });
});
