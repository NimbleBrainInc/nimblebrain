/**
 * Eval test helpers — thin wrappers for running eval cases against a real LLM.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test test/eval/
 *
 * Evals are NOT included in `bun run test` or `bun run verify`.
 * They require a real API key and cost real money.
 */

import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { ChatResult } from "../../src/runtime/types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_ITERATIONS = 5;

// ---------------------------------------------------------------------------
// Runtime lifecycle
// ---------------------------------------------------------------------------

let _runtime: Runtime | null = null;
let _workDir: string | null = null;

/**
 * Get or create a shared Runtime for the eval suite.
 * Reuses the same instance across tests in a file to avoid startup overhead.
 */
export async function getEvalRuntime(): Promise<Runtime> {
  if (_runtime) return _runtime;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for evals. Run with: ANTHROPIC_API_KEY=sk-ant-... bun test test/eval/",
    );
  }

  _workDir = join(tmpdir(), `nimblebrain-eval-${Date.now()}`);
  mkdirSync(_workDir, { recursive: true });

  _runtime = await Runtime.start({
    model: { provider: "anthropic", apiKey },
    defaultModel: DEFAULT_MODEL,
    noDefaultBundles: true,
    workDir: _workDir,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    telemetry: { enabled: false },
    logging: { disabled: true },
  });

  return _runtime;
}

/**
 * Shutdown the shared runtime and clean up temp files.
 * Call this in afterAll().
 */
export async function shutdownEvalRuntime(): Promise<void> {
  if (_runtime) {
    await _runtime.shutdown();
    _runtime = null;
  }
  if (_workDir && existsSync(_workDir)) {
    rmSync(_workDir, { recursive: true });
    _workDir = null;
  }
}

// ---------------------------------------------------------------------------
// Eval runner
// ---------------------------------------------------------------------------

export interface EvalCase {
  /** Human-readable name for the test case. */
  name: string;
  /** The user message to send. */
  input: string;
  /** Assertion function — receives ChatResult, throws on failure. */
  assert: (result: ChatResult) => void;
}

/**
 * Run a single eval case: send a message via runtime.chat() and return the result.
 */
export async function runEval(input: string): Promise<ChatResult> {
  const runtime = await getEvalRuntime();
  return runtime.chat({ message: input });
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a specific tool was called at least once.
 */
export function assertToolCalled(result: ChatResult, toolName: string): void {
  const called = result.toolCalls.some((tc) => tc.name === toolName);
  if (!called) {
    const calledTools = result.toolCalls.map((tc) => tc.name).join(", ") || "(none)";
    throw new Error(
      `Expected tool "${toolName}" to be called. Tools called: ${calledTools}`,
    );
  }
}

/**
 * Assert that a specific tool was called with input matching a predicate.
 */
export function assertToolCalledWith(
  result: ChatResult,
  toolName: string,
  inputMatch: (input: Record<string, unknown>) => boolean,
): void {
  const matching = result.toolCalls.filter(
    (tc) => tc.name === toolName && inputMatch(tc.input),
  );
  if (matching.length === 0) {
    const calls = result.toolCalls
      .filter((tc) => tc.name === toolName)
      .map((tc) => JSON.stringify(tc.input))
      .join(", ");
    throw new Error(
      `Expected tool "${toolName}" to be called with matching input. ` +
        (calls ? `Calls to ${toolName}: ${calls}` : `Tool "${toolName}" was never called.`),
    );
  }
}

/**
 * Assert that a tool was NOT called.
 */
export function assertToolNotCalled(result: ChatResult, toolName: string): void {
  const called = result.toolCalls.some((tc) => tc.name === toolName);
  if (called) {
    throw new Error(`Expected tool "${toolName}" NOT to be called, but it was.`);
  }
}

/**
 * Assert that nb__search was called with a query containing the given keyword.
 */
export function assertSearchedFor(result: ChatResult, keyword: string): void {
  assertToolCalledWith(result, "nb__search", (input) => {
    const query = String(input.query ?? "").toLowerCase();
    return query.includes(keyword.toLowerCase());
  });
}
