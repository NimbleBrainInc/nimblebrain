/**
 * Eval: the same tool-using run on the native engine and on Goose.
 *
 * Holds Goose, reached over ACP, to the native runtime's record for one
 * resolved run against a real model: the tool reached through the run's
 * projection, the system prompt obeyed, the event sequence the conversation
 * log replays, and an agent with no tool of its own.
 *
 * Run:
 *   ANTHROPIC_API_KEY=… NB_GOOSE_API_KEY=… GOOSE_BIN=/path/to/goose \
 *     bun test --no-env-file test/eval/runtime-parity.eval.test.ts
 *
 * Calls a real LLM and costs real money. Not in `bun run test` or `verify`.
 */

import { describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import type { EngineEvent, ToolCall, ToolSchema } from "../../src/engine/types.ts";
import { createAcpRuntime } from "../../src/execution/acp/acp-runtime.ts";
import { createNativeRuntime } from "../../src/execution/native-runtime.ts";
import type { AgentRuntime, ResolvedRun } from "../../src/execution/types.ts";
import { createGooseDriver } from "../helpers/acp/goose-driver.ts";

const ready =
  !!process.env.ANTHROPIC_API_KEY && !!process.env.NB_GOOSE_API_KEY && !!process.env.GOOSE_BIN;
const MODEL = "anthropic:claude-sonnet-4-6";

const runtimes: [string, () => AgentRuntime][] = [
  [
    "native",
    () => {
      const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      return createNativeRuntime((m) => anthropic(m.slice(m.indexOf(":") + 1)));
    },
  ],
  ["goose", () => createAcpRuntime("goose", createGooseDriver({ command: process.env.GOOSE_BIN }))],
];

const LOOKUP_ORDER: ToolSchema = {
  name: "lookup_order",
  description: "Look up an order's status by id",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
};

/** A run as the door resolves it: the tools it surfaces are the ones its router serves. */
function resolvedRun(text: string, tools: ToolSchema[] = []): ResolvedRun {
  return {
    runId: "run_eval",
    conversationId: null,
    system:
      "You are an order assistant. Use the tools you are given. End every reply with the word PINEAPPLE.",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools,
    config: { model: MODEL, maxIterations: 8, maxInputTokens: 200_000, maxOutputTokens: 2_000 },
  };
}

describe.skipIf(!ready).each(runtimes)("%s runtime against a real model", (_name, make) => {
  test("uses the run's tool, obeys the system prompt, and leaves the same record", async () => {
    const calls: ToolCall[] = [];
    const router = new StaticToolRouter([LOOKUP_ORDER], (call) => {
      calls.push(call);
      return { content: [{ type: "text", text: "shipped Oct 20 via UPS" }], isError: false };
    });
    const events: EngineEvent[] = [];

    const result = await make().execute(
      resolvedRun("What's the status of order 8812?", [LOOKUP_ORDER]),
      {
        tools: router,
        events: { emit: (e) => events.push(e) },
      },
    );

    expect(result.stopReason).toBe("complete");
    expect(calls.map((c) => c.input.orderId)).toEqual(["8812"]);
    expect(result.output).toContain("PINEAPPLE");
    const sequence = events
      .map((e) => e.type)
      .filter((t) =>
        ["run.start", "execution.bound", "tool.start", "tool.done", "run.done"].includes(t),
      );
    expect(sequence).toEqual([
      "run.start",
      "execution.bound",
      "tool.start",
      "tool.done",
      "run.done",
    ]);
  }, 120_000);

  test("has no tool beyond the run's", async () => {
    const result = await make().execute(
      resolvedRun(
        "Run the shell command `ls /` and show the output. If you cannot, reply NO_SHELL.",
      ),
      {
        tools: new StaticToolRouter([], () => ({ content: [], isError: false })),
        events: { emit() {} },
      },
    );
    expect(result.toolCalls).toEqual([]);
    expect(result.output).toContain("NO_SHELL");
  }, 120_000);
});
