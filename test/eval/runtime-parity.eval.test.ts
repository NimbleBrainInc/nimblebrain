/**
 * Eval: the same runs on the native engine, on Goose, and on nimblebrain-agent.
 *
 * Holds each agent reached over ACP to the native runtime's record against a
 * real model: the tool reached through the run's projection, the system
 * prompt obeyed, the event sequence the conversation log replays, no tool of
 * the agent's own, multi-turn from the history the door hands over,
 * cancellation, and a bad key as a run error. Each runtime runs when its own
 * variables are set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=… bun test --no-env-file test/eval/runtime-parity.eval.test.ts
 *     + NB_GOOSE_API_KEY=… GOOSE_BIN=/path/to/goose            for Goose
 *       (NB_GOOSE_MODEL_ENDPOINT=… to send its model calls to an endpoint, such as the gateway)
 *     + NB_AGENT_API_KEY=…                                     for nimblebrain-agent
 *       (the pinned dev dependency; NB_AGENT_BIN=/path/to/nimblebrain-agent/src/cli.ts runs another)
 *
 * Calls a real LLM and costs real money. Not in `bun run test` or `verify`.
 */

import { describe, expect, test } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import type { EngineEvent, ToolCall, ToolSchema } from "../../src/engine/types.ts";
import { createAcpRuntime } from "../../src/execution/acp/acp-runtime.ts";
import { createNimbleBrainAgentDriver } from "../../src/execution/acp/drivers/nimblebrain-agent.ts";
import { createNativeRuntime } from "../../src/execution/native-runtime.ts";
import type { AgentRuntime, ResolvedRun } from "../../src/execution/types.ts";
import { createGooseDriver, gooseConnection } from "../helpers/acp/goose-driver.ts";
import { agentConnection } from "../helpers/acp/nimblebrain-agent-driver.ts";

const env = process.env;
const MODEL = "anthropic:claude-sonnet-4-6";

interface Candidate {
  name: string;
  ready: boolean;
  /** Reached over ACP: holds cancellation and a bad key to the ACP path's contract. */
  acp: boolean;
  make(keys?: Record<string, string | undefined>): AgentRuntime;
}

const CANDIDATES: Candidate[] = [
  {
    name: "native",
    ready: !!env.ANTHROPIC_API_KEY,
    acp: false,
    make: () => {
      const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
      return createNativeRuntime((m) => anthropic(m.slice(m.indexOf(":") + 1)));
    },
  },
  {
    name: "goose",
    ready: !!env.NB_GOOSE_API_KEY && !!env.GOOSE_BIN,
    acp: true,
    make: (keys) =>
      createAcpRuntime(
        "goose",
        createGooseDriver(),
        gooseConnection(
          { command: env.GOOSE_BIN, modelEndpoint: env.NB_GOOSE_MODEL_ENDPOINT },
          keys ? { env: keys } : undefined,
        ),
      ),
  },
  {
    name: "nimblebrain-agent",
    ready: !!env.NB_AGENT_API_KEY,
    acp: true,
    make: (keys) =>
      createAcpRuntime(
        "nimblebrain-agent",
        createNimbleBrainAgentDriver(),
        agentConnection({ command: env.NB_AGENT_BIN }, keys ?? env),
      ),
  },
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
function resolvedRun(
  text: string,
  opts: { tools?: ToolSchema[]; history?: LanguageModelV4Message[]; signal?: AbortSignal } = {},
): ResolvedRun {
  return {
    runId: "run_eval",
    conversationId: null,
    system:
      "You are an order assistant. Use the tools you are given. End every reply with the word PINEAPPLE.",
    messages: [...(opts.history ?? []), { role: "user", content: [{ type: "text", text }] }],
    tools: opts.tools ?? [],
    config: {
      model: MODEL,
      maxIterations: 8,
      maxInputTokens: 200_000,
      maxOutputTokens: 2_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  };
}

const NO_TOOLS = new StaticToolRouter([], () => ({ content: [], isError: false }));

for (const candidate of CANDIDATES) {
  describe.skipIf(!candidate.ready)(`${candidate.name} runtime against a real model`, () => {
    test("uses the run's tool, obeys the system prompt, and leaves the same record", async () => {
      const calls: ToolCall[] = [];
      const router = new StaticToolRouter([LOOKUP_ORDER], (call) => {
        calls.push(call);
        return { content: [{ type: "text", text: "shipped Oct 20 via UPS" }], isError: false };
      });
      const events: EngineEvent[] = [];

      const result = await candidate
        .make()
        .execute(resolvedRun("What's the status of order 8812?", { tools: [LOOKUP_ORDER] }), {
          tools: router,
          events: { emit: (e) => events.push(e) },
          billSummary: () => {},
        });

      expect(result.stopReason).toBe("complete");
      expect(calls.map((c) => c.input.orderId)).toEqual(["8812"]);
      expect(result.output).toContain("PINEAPPLE");
      expect(events.some((e) => e.type === "text.delta")).toBe(true);
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
      const result = await candidate
        .make()
        .execute(
          resolvedRun(
            "Run the shell command `ls /` and show the output. If you cannot, reply NO_SHELL.",
          ),
          { tools: NO_TOOLS, events: { emit() {} }, billSummary: () => {} },
        );
      expect(result.toolCalls).toEqual([]);
      expect(result.output).toContain("NO_SHELL");
    }, 120_000);

    test("continues a conversation from the history the door hands over", async () => {
      const result = await candidate.make().execute(
        resolvedRun("Which order did I ask about, and what was its status? No tools.", {
          history: [
            { role: "user", content: [{ type: "text", text: "Where is order 4471?" }] },
            {
              role: "assistant",
              content: [
                { type: "text", text: "Order 4471 shipped yesterday via FedEx. PINEAPPLE" },
              ],
            },
          ],
        }),
        { tools: NO_TOOLS, events: { emit() {} }, billSummary: () => {} },
      );
      expect(result.output).toContain("4471");
      expect(result.output.toLowerCase()).toContain("fedex");
    }, 120_000);

    test.skipIf(!candidate.acp)(
      "a cancel mid-tool ends the run as cancelled",
      async () => {
        const controller = new AbortController();
        const router = new StaticToolRouter([LOOKUP_ORDER], async () => {
          controller.abort();
          await Bun.sleep(100);
          return { content: [{ type: "text", text: "late" }], isError: false };
        });
        const events: EngineEvent[] = [];
        const run = candidate.make().execute(
          resolvedRun("What's the status of order 5?", {
            tools: [LOOKUP_ORDER],
            signal: controller.signal,
          }),
          { tools: router, events: { emit: (e) => events.push(e) }, billSummary: () => {} },
        );
        await expect(run).rejects.toBeDefined();
        expect(
          events
            .filter((e) => e.type === "run.done")
            .map((e) => e.type === "run.done" && e.data.stopReason),
        ).toEqual(["cancelled"]);
      },
      120_000,
    );

    test.skipIf(!candidate.acp)(
      "a bad provider key is a run error, not a crash",
      async () => {
        const events: EngineEvent[] = [];
        const run = candidate
          .make({ NB_GOOSE_API_KEY: "sk-ant-invalid", NB_AGENT_API_KEY: "sk-ant-invalid" })
          .execute(resolvedRun("hello"), {
            tools: NO_TOOLS,
            events: { emit: (e) => events.push(e) },
            billSummary: () => {},
          });
        // The session opened, so the failure is the provider refusing the key, not a
        // startup failure or a crash. ACP carries the provider's reason in the
        // message or in the error's data.
        const err = (await run.then(
          () => undefined,
          (e: unknown) => e,
        )) as { message?: string; data?: unknown } | undefined;
        expect(err).toBeDefined();
        expect(`${err?.message} ${JSON.stringify(err?.data ?? null)}`).toMatch(
          /authentication|api[-_ ]?key/i,
        );
        expect(events.filter((e) => e.type === "execution.bound")).toHaveLength(1);
        expect(events.filter((e) => e.type === "run.error")).toHaveLength(1);
      },
      120_000,
    );
  });
}
