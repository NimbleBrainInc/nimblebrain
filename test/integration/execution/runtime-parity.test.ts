import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV4,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import type { StoredMessage } from "../../../src/conversation/types.ts";
import type {
  EngineEvent,
  EngineEventOf,
  EventSink,
  ToolCall,
  ToolSchema,
} from "../../../src/engine/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import type { AcpDriver } from "../../../src/execution/acp/driver.ts";
import { createNimbleBrainDriver } from "../../../src/execution/acp/drivers/nimblebrain.ts";
import { createNimbleBrainAcpAgent } from "../../../src/execution/acp-agent/agent.ts";
import { createNativeRuntime } from "../../../src/execution/native-runtime.ts";
import type { AgentRuntime, ResolvedRun, RunIO } from "../../../src/execution/types.ts";
import type { TokenUsage } from "../../../src/usage/types.ts";
import { createEchoModel, type EchoModelResponse } from "../../helpers/echo-model.ts";

// The same resolved run through the native runtime and through ACP to
// NimbleBrain's own agent must leave the same record: the reply, the tool
// calls, and events the conversation log can replay. The agent is reached two
// ways: with NimbleBrain's run `_meta`, and over plain ACP, the path every other
// agent takes (the prompt and history arrive as contained text in the turn).

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

/** A run's IO with summaries billed nowhere, for a run that folds nothing. */
function io(tools: RunIO["tools"], events: RunIO["events"]): RunIO {
  return { tools, events, billSummary: () => {} };
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

/**
 * The reference agent over plain ACP: no run `_meta` and no prompt of the
 * driver's own, so the generic runtime sends its transcript prompt and the
 * agent runs on its own defaults.
 */
function plainAcpDriver(resolveModel: () => LanguageModelV4): AcpDriver {
  return {
    id: "plain-acp",
    toolSurface: "projection",
    async open() {
      return {
        target: createNimbleBrainAcpAgent({
          resolveModel,
          defaults: {
            model: "test:echo",
            maxIterations: 5,
            maxInputTokens: 100_000,
            maxOutputTokens: 1_000,
          },
        }),
        cwd: tmpdir(),
        close: async () => {},
      };
    },
  };
}

/** A model that keeps every prompt it is sent. */
function recording(model: LanguageModelV4, prompts: LanguageModelV4Prompt[]): LanguageModelV4 {
  return {
    ...model,
    doStream: (options) => {
      prompts.push(options.prompt);
      return model.doStream(options);
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
    [
      "acp:plain",
      () =>
        createAcpRuntime(
          "plain-acp",
          plainAcpDriver(() => createEchoModel({ responses: script() })),
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

    const result = await make().execute(resolvedRun(), io(router, sink));

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

describe("acp runtime over plain ACP", () => {
  test("the door's prompt and history reach the agent's model as contained context", async () => {
    const prompts: LanguageModelV4Prompt[] = [];
    const runtime = createAcpRuntime(
      "plain-acp",
      plainAcpDriver(() => recording(createEchoModel({ responses: [{ text: "ok" }] }), prompts)),
    );
    const run = resolvedRun();
    run.messages = [
      { role: "user", content: [{ type: "text", text: "Remember 7." }] },
      { role: "assistant", content: [{ type: "text", text: "Noted." }] },
      ...run.messages,
    ];

    const result = await runtime.execute(
      run,
      io(new StaticToolRouter([LOOKUP], () => ({ content: [], isError: false })), collect()),
    );

    expect(result.stopReason).toBe("complete");
    const sent = JSON.stringify(prompts[0]);
    expect(sent).toContain("<host-instructions>");
    expect(sent).toContain("You are a test agent.");
    expect(sent).toContain("<conversation-history>");
    expect(sent).toContain("User: Remember 7.");
    expect(sent).toContain("Assistant: Noted.");
    expect(sent).toContain("What is the answer?");
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

    const result = await runtime.execute(resolvedRun(), io(router, sink));

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
      billSummary: () => {},
    });

    await expect(run).rejects.toBeDefined();
    expect(toolStarted).toBe(true);
    expect(sink.of("run.done").map((e) => e.data.stopReason)).toEqual(["cancelled"]);
    expect(sink.of("run.error")).toEqual([]);
  });

  test("cancelling during session setup ends the run before it prompts", async () => {
    const controller = new AbortController();
    let prompted = false;
    const driver = plainAcpDriver(() => {
      prompted = true;
      return createEchoModel({ responses: structuredClone(SCRIPT) });
    });
    const runtime = createAcpRuntime("plain-acp", {
      ...driver,
      async prepareSession() {
        controller.abort();
      },
    });
    const sink = collect();

    await expect(
      runtime.execute(resolvedRun(controller.signal), {
        tools: new StaticToolRouter([LOOKUP], () => ({ content: [], isError: false })),
        events: sink,
        billSummary: () => {},
      }),
    ).rejects.toBeDefined();
    expect(prompted).toBe(false);
    expect(sink.of("run.done").map((e) => e.data.stopReason)).toEqual(["cancelled"]);
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
        billSummary: () => {},
      }),
    ).rejects.toThrow(/Invalid params/);
    expect(sink.of("run.error")).toHaveLength(1);
  });
});

/** The reference agent without its driver: it refuses a session with no run `_meta`. */
function createNimbleBrainAgentWithoutMeta() {
  return createNimbleBrainAcpAgent({ resolveModel: () => createEchoModel() });
}

describe("acp runtime with the driver's per-call usage", () => {
  const callUsage = (inputTokens: number): TokenUsage => ({ inputTokens, outputTokens: 5 });

  /** Replay a run's events from a conversation log, as the next turn reads them. */
  async function replayed(events: EngineEvent[]): Promise<StoredMessage[]> {
    const dir = join(mkdtempSync(join(tmpdir(), "acp-replay-")), "conversations");
    const store = new EventSourcedConversationStore({ dir });
    const conversation = await store.create({ model: "test:echo", ownerId: "user_test" });
    store.setActiveConversation(conversation.id);
    for (const event of events) store.emit(event);
    await store.flush();
    return store.history(conversation);
  }

  const shape = (messages: StoredMessage[]) =>
    messages.map((m) => [
      m.role,
      (Array.isArray(m.content) ? m.content : []).map((p) =>
        // Whitespace between segments differs by runtime, as `output` does.
        p.type === "text" ? `text:${p.text.trim()}` : p.type,
      ),
    ]);

  test("prices each call, bills summaries, and replays as the native turn does", async () => {
    const reported = createNimbleBrainDriver({
      resolveModel: () => createEchoModel({ responses: structuredClone(SCRIPT) }),
    });
    const runtime = createAcpRuntime("reported-usage", {
      ...reported,
      outcome: () => ({
        stopReason: "complete",
        calls: [
          { model: "test:echo", purpose: "turn", usage: callUsage(100) },
          { model: "test:fast", purpose: "summary", usage: callUsage(40) },
          { model: "test:echo", purpose: "turn", usage: callUsage(30) },
        ],
      }),
    });
    const router = () =>
      new StaticToolRouter([LOOKUP], () => ({
        content: [{ type: "text", text: "42" }],
        isError: false,
      }));
    const acpSink = collect();
    const summaries: [string, number][] = [];
    const result = await runtime.execute(resolvedRun(), {
      tools: router(),
      events: acpSink,
      billSummary: (model, usage) => summaries.push([model, usage.inputTokens]),
    });
    const nativeSink = collect();
    await createNativeRuntime(() =>
      createEchoModel({ responses: structuredClone(SCRIPT) }),
    ).execute(resolvedRun(), io(router(), nativeSink));

    expect(
      acpSink
        .of("llm.done")
        .map((e) => e.data.usage.inputTokens)
        .filter((n) => n > 0),
    ).toEqual([100, 30]);
    expect(summaries).toEqual([["test:fast", 40]]);
    expect(result.usage.inputTokens).toBe(130);
    expect(result.iterations).toBe(2);
    expect(shape(await replayed(acpSink.events))).toEqual(shape(await replayed(nativeSink.events)));
  });
});
