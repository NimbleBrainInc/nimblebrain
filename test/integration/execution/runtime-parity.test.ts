import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
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
import { CANCEL_GRACE_MS, createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import type { AcpDriver, AcpOutcome } from "../../../src/execution/acp/driver.ts";
import { createNativeRuntime } from "../../../src/execution/native-runtime.ts";
import type { AgentRuntime, ResolvedRun, RunIO } from "../../../src/execution/types.ts";
import type { TokenUsage } from "../../../src/usage/types.ts";
import {
  emptyLog,
  type ScriptedAgentOptions,
  scriptedConnection,
  scriptedDriver,
  stepsFrom,
} from "../../helpers/acp/scripted-agent.ts";
import { createEchoModel, type EchoModelResponse } from "../../helpers/echo-model.ts";

// The same resolved run through the native runtime and through the generic
// ACP runtime must leave the same record: the reply, the tool calls, and events
// the conversation log can replay. The ACP side is a scripted agent playing the
// echo model's script over plain ACP, so the prompt and history reach it as
// contained text in the turn, the path every ACP agent without a driver of its
// own takes.

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

/** An ACP runtime over the scripted agent playing `script`. */
function scriptedRuntime(script: EchoModelResponse[], opts: Partial<ScriptedAgentOptions> = {}) {
  const steps = stepsFrom(script);
  return createAcpRuntime(
    "scripted-acp",
    scriptedDriver(),
    scriptedConnection({ script: () => steps, ...opts }),
  );
}

function runtimes(script: () => EchoModelResponse[]): [string, () => AgentRuntime][] {
  return [
    ["native", () => createNativeRuntime(() => createEchoModel({ responses: script() }))],
    ["acp", () => scriptedRuntime(script())],
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
  test("the door's prompt and history reach the agent as contained context", async () => {
    const log = emptyLog();
    const runtime = scriptedRuntime([{ text: "ok" }], { log });
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
    const sent = log.prompts[0] ?? "";
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
    const runtime = scriptedRuntime([
      { toolCalls: [{ toolCallId: "m1", toolName: "secret_tool", input: "{}" }] },
      { text: "done" },
    ]);

    const result = await runtime.execute(resolvedRun(), io(router, sink));

    expect(result.stopReason).toBe("complete");
    expect(reached).toEqual([]);
    expect(sink.of("tool.done")).toEqual([]);
  });

  test("cancelling mid-tool ends the run as cancelled", async () => {
    const controller = new AbortController();
    let toolStarted = false;
    const router = new StaticToolRouter([LOOKUP], async (_call) => {
      controller.abort();
      await Bun.sleep(20);
      return { content: [{ type: "text", text: "late" }], isError: false };
    });
    const sink = collect();
    const runtime = scriptedRuntime(structuredClone(SCRIPT));

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
    const log = emptyLog();
    const runtime = createAcpRuntime(
      "scripted-acp",
      {
        ...scriptedDriver(),
        async prepareSession() {
          controller.abort();
        },
      },
      scriptedConnection({ script: () => stepsFrom(structuredClone(SCRIPT)), log }),
    );
    const sink = collect();

    await expect(
      runtime.execute(resolvedRun(controller.signal), {
        tools: new StaticToolRouter([LOOKUP], () => ({ content: [], isError: false })),
        events: sink,
        billSummary: () => {},
      }),
    ).rejects.toBeDefined();
    expect(log.prompts).toEqual([]);
    expect(sink.of("run.done").map((e) => e.data.stopReason)).toEqual(["cancelled"]);
  });

  test("an agent that ignores the cancel is cut off after the grace, and the run ends cancelled", async () => {
    const controller = new AbortController();
    const runtime = createAcpRuntime(
      "scripted-acp",
      scriptedDriver(),
      scriptedConnection({ script: () => [], unresponsive: true }),
    );
    const sink = collect();
    const execution = runtime.execute(resolvedRun(controller.signal), {
      tools: new StaticToolRouter([LOOKUP], () => ({ content: [], isError: false })),
      events: {
        emit(e) {
          sink.emit(e);
          if (e.type === "execution.bound") setTimeout(() => controller.abort(), 20);
        },
      },
      billSummary: () => {},
    });

    const started = Date.now();
    await expect(execution).rejects.toBeDefined();
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(CANCEL_GRACE_MS);
    expect(waited).toBeLessThan(CANCEL_GRACE_MS + 2_000);
    expect(sink.of("run.done").map((e) => e.data.stopReason)).toEqual(["cancelled"]);
  }, 10_000);

  test("an agent that fails the session is a run error, not a crash", async () => {
    const sink = collect();
    const runtime = createAcpRuntime(
      "broken",
      scriptedDriver(),
      scriptedConnection({ script: () => [], refuseSession: true }),
    );

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

describe("acp runtime with the driver's per-call usage", () => {
  const callUsage = (inputTokens: number): TokenUsage => ({ inputTokens, outputTokens: 5 });

  test("prices each call, bills summaries, and replays as the native turn does", async () => {
    const steps = stepsFrom(structuredClone(SCRIPT));
    const runtime = createAcpRuntime(
      "reported-usage",
      {
        ...scriptedDriver(),
        outcome: () => ({
          stopReason: "complete",
          calls: [
            { model: "test:echo", purpose: "turn", usage: callUsage(100) },
            { model: "test:fast", purpose: "summary", usage: callUsage(40) },
            { model: "test:echo", purpose: "turn", usage: callUsage(30) },
          ],
        }),
      },
      scriptedConnection({ script: () => steps }),
    );
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

describe("acp runtime cancelled with the driver's per-call usage", () => {
  const callUsage = (inputTokens: number): TokenUsage => ({ inputTokens, outputTokens: 5 });

  const CALLS: AcpOutcome["calls"] = [
    { model: "test:echo", purpose: "turn", usage: callUsage(100) },
    { model: "test:fast", purpose: "summary", usage: callUsage(40) },
  ];

  /** Cancel mid-tool, with the driver reading `calls` from the agent's `cancelled` answer. */
  async function cancelMidTool(
    calls: AcpOutcome["calls"],
    driver: Partial<AcpDriver> = calls ? { outcome: () => ({ calls }) } : {},
    cancelledAnswer?: ScriptedAgentOptions["cancelledAnswer"],
  ) {
    const controller = new AbortController();
    const steps = stepsFrom(structuredClone(SCRIPT));
    const runtime = createAcpRuntime(
      "reported-usage",
      { ...scriptedDriver(), ...driver },
      scriptedConnection({ script: () => steps, cancelledAnswer }),
    );
    const router = new StaticToolRouter([LOOKUP], async () => {
      controller.abort();
      await Bun.sleep(20);
      return { content: [{ type: "text", text: "late" }], isError: false };
    });
    const sink = collect();
    const summaries: [string, number][] = [];
    await expect(
      runtime.execute(resolvedRun(controller.signal), {
        tools: router,
        events: sink,
        billSummary: (model, usage) => summaries.push([model, usage.inputTokens]),
      }),
    ).rejects.toBeDefined();
    return { sink, summaries };
  }

  test("prices the calls made before the cancel and replays as an unpriced cancel", async () => {
    const reported = await cancelMidTool(CALLS);
    const unpriced = await cancelMidTool(undefined);

    expect(
      reported.sink
        .of("llm.done")
        .filter((e) => !e.data.transcriptOnly)
        .map((e) => e.data.usage.inputTokens),
    ).toEqual([100]);
    expect(reported.summaries).toEqual([["test:fast", 40]]);
    expect(reported.sink.of("run.done").map((e) => e.data.stopReason)).toEqual(["cancelled"]);
    expect(shape(await replayed(reported.sink.events))).toEqual(
      shape(await replayed(unpriced.sink.events)),
    );
  });

  test.each([
    [
      "fails its prompt with the model failure",
      { modelFailure: () => ({ status: 500, outcome: { calls: CALLS } }) },
      () => {
        throw new Error("the model call failed");
      },
    ],
    [
      "answers end_turn",
      { outcome: () => ({ calls: CALLS }) },
      () => ({ stopReason: "end_turn" as const }),
    ],
  ] as const)(
    "an agent that %s as the cancel lands is priced once and ends cancelled",
    async (_case, driver, answer) => {
      const { sink, summaries } = await cancelMidTool(CALLS, driver, answer);

      expect(
        sink
          .of("llm.done")
          .filter((e) => !e.data.transcriptOnly)
          .map((e) => e.data.usage.inputTokens),
      ).toEqual([100]);
      expect(summaries).toEqual([["test:fast", 40]]);
      expect(sink.of("run.done").map((e) => e.data.stopReason)).toEqual(["cancelled"]);
    },
  );
});

describe("bound skill guidance", () => {
  const GUIDE = {
    name: "lookup-guide",
    body: "Always quote the answer.",
    scope: "connector",
    toolAffinity: ["lookup"],
  };
  // The first call is held for its guidance, the second runs, then the reply.
  const HELD_SCRIPT: EchoModelResponse[] = [
    { toolCalls: [{ toolCallId: "m1", toolName: "lookup", input: '{"q":"answer"}' }] },
    { toolCalls: [{ toolCallId: "m2", toolName: "lookup", input: '{"q":"answer"}' }] },
    { text: "The answer is 42." },
  ];

  function boundRun(): ResolvedRun {
    const run = resolvedRun();
    run.config = { ...run.config, connectorSkillCandidates: [GUIDE] };
    return run;
  }

  async function runOn(runtime: AgentRuntime, run = boundRun()) {
    const calls: ToolCall[] = [];
    const router = new StaticToolRouter([LOOKUP], (call) => {
      calls.push(call);
      return { content: [{ type: "text", text: "42" }], isError: false };
    });
    const sink = collect();
    const result = await runtime.execute(run, io(router, sink));
    return { calls, sink, result };
  }

  test("holds the first call on every runtime, and leaves the engine's record", async () => {
    const log = emptyLog();
    const native = await runOn(
      createNativeRuntime(() => createEchoModel({ responses: structuredClone(HELD_SCRIPT) })),
    );
    const acp = await runOn(scriptedRuntime(structuredClone(HELD_SCRIPT), { log }));

    for (const { calls, sink, result } of [native, acp]) {
      expect(result.output.trim()).toBe("The answer is 42.");
      // The tool ran once: the held call did not reach it.
      expect(calls).toHaveLength(1);
      expect(sink.of("tool.done").map((e) => [e.data.ok, e.data.held ?? false])).toEqual([
        [false, true],
        [true, false],
      ]);
      const [injected] = sink.of("connector.skill.injected");
      expect(injected?.data).toMatchObject({
        skillName: "lookup-guide",
        skillBody: "Always quote the answer.",
        toolName: "lookup",
      });
      expect(injected?.data.heldToolCallId).toBe(sink.of("tool.done")[0]?.data.id);
    }

    // The agent read the guidance in the held call's result.
    expect(log.toolResults[0]).toContain("<connector-skill>");
    expect(log.toolResults[0]).toContain("Always quote the answer.");

    // And a later turn replays the guidance where the native turn put it.
    expect(shape(await replayed(acp.sink.events))).toEqual(
      shape(await replayed(native.sink.events)),
    );
  });

  test("a skill the conversation already delivered holds nothing", async () => {
    const run = boundRun();
    run.config = { ...run.config, alreadyInjectedConnectorSkills: ["lookup-guide"] };
    const { calls, sink } = await runOn(scriptedRuntime(structuredClone(SCRIPT)), run);
    expect(calls).toHaveLength(1);
    expect(sink.of("connector.skill.injected")).toEqual([]);
  });
});

describe("how the agent reaches the projection", () => {
  const router = () =>
    new StaticToolRouter([LOOKUP], () => ({
      content: [{ type: "text", text: "42" }],
      isError: false,
    }));

  async function declared(mcp: ScriptedAgentOptions["mcp"]) {
    const log = emptyLog();
    await scriptedRuntime(structuredClone(SCRIPT), { mcp, log }).execute(
      resolvedRun(),
      io(router(), collect()),
    );
    return log;
  }

  test("an agent gets the projection on its own connection, and nothing listens", async () => {
    const log = await declared({ acp: true, http: true });
    const [server] = log.mcpServers[0] ?? [];
    expect(server).toMatchObject({ type: "acp", name: "nimblebrain" });
    expect(server && "url" in server).toBe(false);
    expect(log.toolResults).toEqual(["42"]);
  });

  test("a server id is random per run, never reused", async () => {
    const ids = await Promise.all(
      [0, 1].map(async () => {
        const [server] = (await declared({ acp: true })).mcpServers[0] ?? [];
        return server && "serverId" in server ? server.serverId : undefined;
      }),
    );
    expect(ids[0]).toMatch(/^nb_[0-9a-f]{32}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });

  test.each([
    ["only HTTP", { http: true }],
    ["no MCP server", {}],
  ])(
    "an agent that takes %s is refused before its session: it runs behind the bridge",
    async (_what, mcp) => {
      const log = emptyLog();
      const sink = collect();
      await expect(
        scriptedRuntime(structuredClone(SCRIPT), { mcp, log }).execute(
          resolvedRun(),
          io(router(), sink),
        ),
      ).rejects.toThrow(/takes no acp MCP server: it runs behind the bridge/);
      expect(log.mcpServers).toEqual([]);
      expect(sink.of("run.error")).toHaveLength(1);
    },
  );
});
