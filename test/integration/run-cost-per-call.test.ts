/**
 * A run's cost is each model call priced on its own rate card, then summed.
 *
 * On a model whose price depends on prompt length, pricing the run's summed
 * usage as one call would bill every token on the long-prompt card once the
 * calls together crossed its threshold, though no single call did.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatResponseBody } from "../../src/runtime/chat-response.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { estimateCost } from "../../src/usage/cost.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { TEST_IDENTITY } from "../helpers/test-auth-adapter.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const HAIKU = "anthropic:claude-haiku-5-5";
const CALLS = 6;
const CALL_INPUT = 20_000;
const CALL_OUTPUT = 500;

let runtime: Runtime | undefined;
let workDir = "";

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = "";
});

/** A runtime whose model makes `CALLS` calls of `CALL_INPUT` tokens each per run. */
async function start(): Promise<Runtime> {
  workDir = mkdtempSync(join(tmpdir(), "nb-run-cost-"));
  let call = 0;
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createMockModel(() => {
      call++;
      const last = call % CALLS === 0;
      return {
        content: last
          ? [{ type: "text", text: "done" }]
          : [
              {
                type: "tool-call",
                toolCallId: `call-${call}`,
                toolName: "nb__no_such_tool",
                input: "{}",
              },
            ],
        inputTokens: CALL_INPUT,
        outputTokens: CALL_OUTPUT,
      };
    }),
    logging: { disabled: true },
    workDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
  await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, TEST_IDENTITY.id, "admin");
  return runtime;
}

const perCall = estimateCost(HAIKU, { inputTokens: CALL_INPUT, outputTokens: CALL_OUTPUT });
const summed = { inputTokens: CALLS * CALL_INPUT, outputTokens: CALLS * CALL_OUTPUT };

test("the run's calls together cross the long-prompt threshold, though none does alone", () => {
  expect(estimateCost(HAIKU, summed)).toBeGreaterThan(CALLS * perCall * 2);
});

test("a task run's cost sums its calls, each on the base card", async () => {
  const rt = await start();
  const result = await rt.executeTask({
    identity: TEST_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    model: HAIKU,
    prompt: "do the thing",
  });

  expect(result.usage.iterations).toBe(CALLS);
  expect(result.usage.inputTokens).toBe(summed.inputTokens);
  expect(result.costUsd).toBeCloseTo(CALLS * perCall, 10);
});

test("a chat turn's done event carries the same per-call sum", async () => {
  const rt = await start();
  const result = await rt.chat({
    identity: TEST_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    model: HAIKU,
    message: "hello",
  });

  expect(result.usage.inputTokens).toBe(summed.inputTokens);
  expect(chatResponseBody(result).usage.costUsd).toBeCloseTo(CALLS * perCall, 10);
});
