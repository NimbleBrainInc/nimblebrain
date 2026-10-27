import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk/unstable";
import { createAnthropic } from "@ai-sdk/anthropic";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import type {
  EngineEvent,
  EngineEventOf,
  EngineResult,
  ToolCall,
  ToolSchema,
} from "../../../src/engine/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import type { AcpDriver } from "../../../src/execution/acp/driver.ts";
import { createNativeRuntime } from "../../../src/execution/native-runtime.ts";
import type { AgentRuntime, ResolvedRun } from "../../../src/execution/types.ts";
import { agentCommand, createAgentDriver } from "../../helpers/acp/nimblebrain-agent-driver.ts";
import { type FakeAnthropic, startFakeAnthropic } from "../../helpers/fake-anthropic.ts";

// nimblebrain-agent, the pinned dev dependency, against the native runtime on
// the same run, with both pointed at one fake Anthropic endpoint: no network,
// no key. The run makes one tool call through the run's tools and then answers
// in text, and both runtimes must leave the same record.
//
// The parity cases that land with the driver's next changes are not here: the
// stop-reason table (D1), the bound's idempotence (D2), parallel calls (D3),
// usage and cost (D4), compaction gating (D5), and two turns across runtimes (D6).

const MODEL = "anthropic:claude-sonnet-4-6";

const LOOKUP_ORDER: ToolSchema = {
  name: "lookup_order",
  description: "Look up an order's status by id",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
};

let fake: FakeAnthropic;
beforeAll(() => {
  fake = startFakeAnthropic({ toolInput: '{"orderId":"8812"}' });
});
afterAll(async () => {
  await fake.close();
});

function resolvedRun(): ResolvedRun {
  return {
    runId: "run_agent",
    conversationId: null,
    system: "You are an order assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Where is order 8812?" }] }],
    tools: [LOOKUP_ORDER],
    config: { model: MODEL, maxIterations: 5, maxInputTokens: 100_000, maxOutputTokens: 1_000 },
  };
}

function nativeRuntime(): AgentRuntime {
  const anthropic = createAnthropic({ apiKey: "sk-test", baseURL: fake.baseUrl });
  return createNativeRuntime((m) => anthropic(m.slice(m.indexOf(":") + 1)));
}

/** What a run left behind for the clean-up checks. */
interface Opened {
  root?: string;
  pids: number[];
  /** The MCP server the run declared for its projection. */
  projection?: AcpMcpServer;
}

/** The pinned agent's driver, recording the run's directory, process and projection. */
function agentDriver(opened: Opened): AcpDriver {
  const driver = createAgentDriver(
    { modelEndpoint: fake.baseUrl },
    { NB_AGENT_API_KEY: "sk-test" },
  );
  return {
    ...driver,
    async open(run) {
      const connection = await driver.open(run);
      opened.root = dirname(connection.cwd);
      const found = Bun.spawnSync(["pgrep", "-f", agentCommand({})]).stdout.toString();
      opened.pids.push(...found.split("\n").filter(Boolean).map(Number));
      return connection;
    },
    sessionMeta(run, plan) {
      opened.projection = plan.mcpServers[0];
      return driver.sessionMeta?.(run, plan) ?? {};
    },
  };
}

interface Outcome {
  result: EngineResult;
  events: EngineEvent[];
  calls: ToolCall[];
}

async function execute(runtime: AgentRuntime): Promise<Outcome> {
  const calls: ToolCall[] = [];
  const router = new StaticToolRouter([LOOKUP_ORDER], (call) => {
    calls.push(call);
    return { content: [{ type: "text", text: "shipped Oct 20" }], isError: false };
  });
  const events: EngineEvent[] = [];
  const result = await runtime.execute(resolvedRun(), {
    tools: router,
    events: { emit: (e) => events.push(e) },
    billSummary: () => {},
  });
  return { result, events, calls };
}

/** The events a conversation log and the browser stream key on, in order. */
const RECORD_EVENTS: EngineEvent["type"][] = [
  "run.start",
  "execution.bound",
  "tool.start",
  "tool.done",
  "run.done",
];
const sequence = (events: EngineEvent[]) =>
  events.map((e) => e.type).filter((t) => RECORD_EVENTS.includes(t));

describe("nimblebrain-agent against the native runtime", () => {
  test("one tool call then text leaves the same record on both", async () => {
    const opened: Opened = { pids: [] };
    const native = await execute(nativeRuntime());
    const nativeRequests = fake.requests.length;
    const agent = await execute(createAcpRuntime("nimblebrain-agent", agentDriver(opened)));

    // Each runtime's model calls reached the fake endpoint: the tool call, then the answer.
    expect(nativeRequests).toBe(2);
    expect(fake.requests.length - nativeRequests).toBe(2);

    for (const { result, events, calls } of [native, agent]) {
      expect(result.stopReason).toBe("complete");
      expect(result.output.trim()).toBe("The tool says: shipped Oct 20");
      expect(calls.map((c) => [c.name, c.input])).toEqual([["lookup_order", { orderId: "8812" }]]);
      expect(result.toolCalls.map((c) => [c.name, c.ok, c.output])).toEqual([
        ["lookup_order", true, "shipped Oct 20"],
      ]);
      expect(sequence(events)).toEqual(RECORD_EVENTS);
      const done = events.filter((e): e is EngineEventOf<"run.done"> => e.type === "run.done");
      expect(done.map((e) => e.data.stopReason)).toEqual(["complete"]);
    }
    expect(agent.result.output.trim()).toBe(native.result.output.trim());

    // The run's end takes everything the agent started with it.
    expect(opened.pids.length).toBeGreaterThan(0);
    for (const pid of opened.pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(opened.root).toBeDefined();
    expect(existsSync(opened.root ?? "")).toBe(false);
    // The agent takes MCP servers on its ACP connection, so its tools travelled
    // there: an `acp` server under a random id, and nothing listening for it.
    expect(opened.projection).toMatchObject({ type: "acp", name: "nimblebrain" });
    expect(
      opened.projection && "serverId" in opened.projection && opened.projection.serverId,
    ).toMatch(/^nb_[0-9a-f]{32}$/);
    expect(opened.projection && "url" in opened.projection).toBe(false);
  }, 30_000);
});
