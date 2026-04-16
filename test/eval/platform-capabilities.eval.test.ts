/**
 * Eval: Platform Capability Discovery
 *
 * Tests that the agent correctly discovers and uses built-in platform
 * capabilities (files, conversations, automations) via nb__search.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test test/eval/platform-capabilities.eval.test.ts
 *
 * These tests call a real LLM and cost real money. They are NOT included
 * in `bun run test` or `bun run verify`.
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  runEval,
  shutdownEvalRuntime,
  assertSearchedFor,
  assertToolCalled,
} from "./helpers.ts";

afterAll(async () => {
  await shutdownEvalRuntime();
});

describe("platform capability discovery", () => {
  // -----------------------------------------------------------------------
  // Files
  // -----------------------------------------------------------------------

  describe("files", () => {
    it("discovers files tools when asked about files", async () => {
      const result = await runEval("can you read the files we have?");
      assertSearchedFor(result, "files");
    }, 30_000);

    it("discovers files tools when asked about uploads", async () => {
      const result = await runEval("what files have been uploaded?");
      assertSearchedFor(result, "files");
    }, 30_000);

    it("discovers files tools when asked about documents", async () => {
      const result = await runEval("list my documents");
      assertSearchedFor(result, "files");
    }, 30_000);

    it("discovers files tools for file search", async () => {
      const result = await runEval("search for any PDF files");
      assertSearchedFor(result, "files");
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // Conversations
  // -----------------------------------------------------------------------

  describe("conversations", () => {
    it("discovers conversation tools when referencing past discussion", async () => {
      const result = await runEval("what did we discuss last week?");
      assertSearchedFor(result, "conversations");
    }, 30_000);

    it("discovers conversation tools for recall", async () => {
      const result = await runEval("remember when we talked about the API redesign?");
      assertSearchedFor(result, "conversations");
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // Automations
  // -----------------------------------------------------------------------

  describe("automations", () => {
    it("discovers automation tools when asked to schedule", async () => {
      const result = await runEval("schedule a daily summary at 9am");
      assertSearchedFor(result, "automations");
    }, 30_000);

    it("discovers automation tools when asked about recurring tasks", async () => {
      const result = await runEval("what automations are currently running?");
      assertSearchedFor(result, "automations");
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // Negative cases — should NOT search for platform capabilities
  // -----------------------------------------------------------------------

  describe("negative cases", () => {
    it("does not search files for a general question", async () => {
      const result = await runEval("what is the capital of France?");
      const searchedFiles = result.toolCalls.some(
        (tc) =>
          tc.name === "nb__search" &&
          String(tc.input.query ?? "").toLowerCase().includes("files"),
      );
      expect(searchedFiles).toBe(false);
    }, 30_000);
  });
});
