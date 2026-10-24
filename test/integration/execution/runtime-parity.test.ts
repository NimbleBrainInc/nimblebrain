import { describe, expect, test } from "bun:test";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import type {
  EngineEvent,
  EngineEventOf,
  EventSink,
  ToolCall,
  ToolSchema,
} from "../../../src/engine/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import { createNimbleBrainDriver } from "../../../src/execution/acp/drivers/nimblebrain.ts";
import { createNimbleBrainAcpAgent } from "../../../src/execution/acp-agent/agent.ts";
import { createNativeRuntime } from "../../../src/execution/native-runtime.ts";
import type { AgentRuntime, ResolvedRun } from "../../../src/execution/types.ts";
import { createEchoModel, type EchoModelResponse } from "../../helpers/echo-model.ts";

// The same resolved run through the native runtime and through ACP to
// NimbleBrain's own agent must leave the same record: the reply, the tool
// calls, and events the conversation log can replay.

const LOOKUP: ToolSchema = {
  name: "lookup",
  description: "Look a value up",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};

const SCRIPT: EchoModelResponse[] = [
  {
    text: "Let me check. ",
    toolCalls: [{ toolCallId: "m1", toolName: "lookup", input: '{"q":"answer"}' }],
  },
  { text: "The answer is 42." },
];

interface Collected extends EventSink {
  events: EngineEvent[];
  of<T extends EngineEvent["type"]>(type: T): EngineEventOf<T>[];
}

function collect(): Collected {
  const events: EngineEvent[] = [];
  return {
    events,
    emit: (e) => events.push(e),
    of: <T extends EngineEvent["type"]>(type: T) =>
      events.filter((e): e is EngineEventOf<T> => e.type === type),
  };
}

function resolvedRun(signal?: AbortSignal): ResolvedRun {
  const messages: LanguageModelV4Message[] = [
    { role: "user", content: [{ type: "text", text: "What is the answer?" }] },
  ];
  return {
    runId: "run_test",
    conversationId: null,
    system: "You are a test agent.",
    messages,
    tools: [LOOKUP],
    config: {
      model: "test:echo",
      maxIterations: 5,
      maxInputTokens: 100_000,
      maxOutputTokens: 1_000,
      ...(signal ? { signal } : {}),
    },
  };
}

function runtimes(script: () => EchoModelResponse[]): [string, () => AgentRuntime][] {
  return [
    ["native", () => createNativeRuntime(() => createEchoModel({ responses: script() }))],
    [
      "acp:nimblebrain",
      () =>
        createAcpRuntime(
          "nimblebrain-acp",
          createNimbleBrainDriver({ resolveModel: () => createEchoModel({ responses: script() }) }),
        ),
    ],
  ];
}

describe.each(runtimes(() => structuredClone(SCRIPT)))("%s runtime", (_name, make) => {
  test("answers through an authorized tool and leaves a replayable record", async () => {
    const calls: ToolCall[] = [];
    const router = new StaticToolRouter([LOOKUP], (call) => {
      calls.push(call);
      return { content: [{ type: "text", text: "42" }], isError: false };
    });
    const sink = collect();

    const result = await make().execute(resolvedRun(), { tools: router, events: sink });

    expect(result.stopReason).toBe("complete");
    expect(result.output.trim()).toBe("Let me check. \n\nThe answer is 42.");
    expect(result.toolCalls.map((c) => [c.name, c.ok, c.output])).toEqual([["lookup", true, "42"]]);
    expect(calls.map((c) => c.input)).toEqual([{ q: "answer" }]);

    const streamed = sink
      .of("text.delta")
      .map((e) => e.data.text)
      .join("");
    expect(streamed.trim()).toBe("Let me check. The answer is 42.");

    const [done] = sink.of("tool.done");
    expect(done?.data).toMatchObject({ name: "lookup", ok: true, output: "42" });
    // The segment that ends in the call names it by the id its tool.done carries.
    const toolCallBlocks = sink
      .of("llm.done")
      .flatMap((e) => e.data.content)
      .filter((b) => b.type === "tool-call");
    expect(toolCallBlocks.map((b) => b.type === "tool-call" && b.toolCallId)).toEqual([
      done?.data.id,
    ]);
    expect(sink.of("run.done").map((e) => e.data.stopReason)).toEqual(["complete"]);
  });
});

describe("acp runtime: the projection holds the run's bound", () => {
  test("a tool the router does not serve is refused, and never reaches a handler", async () => {
    const reached: string[] = [];
    const router = new StaticToolRouter([LOOKUP], (call) => {
      reached.push(call.name);
      return { content: [{ type: "text", text: "ok" }], isError: false };
    });
    const sink = collect();
    const runtime = createAcpRuntime(
      "nimblebrain-acp",
      createNimbleBrainDriver({
        resolveModel: () =>
          createEchoModel({
            responses: [
              { toolCalls: [{ toolCallId: "m1", toolName: "secret_tool", input: "{}" }] },
              { text: "done" },
            ],
          }),
      }),
    );

    const result = await runtime.execute(resolvedRun(), { tools: router, events: sink });

    expect(result.stopReason).toBe("complete");
    expect(reached).toEqual([]);
    expect(sink.of("tool.done")).toEqual([]);
  });

  test("cancelling mid-tool ends the run as cancelled and closes the projection", async () => {
    const controller = new AbortController();
    let toolStarted = false;
    const router = new StaticToolRouter([LOOKUP], async (_call) => {
      controller.abort();
      await Bun.sleep(20);
      return { content: [{ type: "text", text: "late" }], isError: false };
    });
    const sink = collect();
    const runtime = createAcpRuntime(
      "nimblebrain-acp",
      createNimbleBrainDriver({
        resolveModel: () => createEchoModel({ responses: structuredClone(SCRIPT) }),
      }),
    );

    const run = runtime.execute(resolvedRun(controller.signal), {
      tools: router,
      events: {
        emit(e) {
          sink.emit(e);
          if (e.type === "tool.start") toolStarted = true;
        },
      },
    });

    await expect(run).rejects.toBeDefined();
    expect(toolStarted).toBe(true);
    expect(sink.of("run.done").map((e) => e.data.stopReason)).toEqual(["cancelled"]);
    expect(sink.of("run.error")).toEqual([]);
  });

  test("an agent that fails the session is a run error, not a crash", async () => {
    const sink = collect();
    const runtime = createAcpRuntime("broken", {
      id: "broken",
      toolSurface: "projection",
      open: async () => ({
        target: createNimbleBrainAgentWithoutMeta(),
        cwd: "/",
        close: async () => {},
      }),
    });

    await expect(
      runtime.execute(resolvedRun(), {
        tools: new StaticToolRouter([], () => ({ content: [], isError: false })),
        events: sink,
      }),
    ).rejects.toThrow(/Invalid params/);
    expect(sink.of("run.error")).toHaveLength(1);
  });
});

/** The reference agent without its driver: it refuses a session with no run `_meta`. */
function createNimbleBrainAgentWithoutMeta() {
  return createNimbleBrainAcpAgent({ resolveModel: () => createEchoModel() });
}
