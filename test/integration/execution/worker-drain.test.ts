import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import type { EngineEvent, EngineEventOf, ToolSchema } from "../../../src/engine/types.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import { AgentConnectionLostError } from "../../../src/execution/acp/connection-lost.ts";
import { createNimbleBrainAgentDriver } from "../../../src/execution/acp/drivers/nimblebrain-agent.ts";
import { createHttpConnection } from "../../../src/execution/acp/http-connection.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import { type ServedWorker, startWorker } from "../../helpers/acp/worker.ts";
import { type FakeAnthropic, startFakeAnthropic } from "../../helpers/fake-anthropic.ts";

// A pool of two real workers behind a stand-in for their Service: each new TCP
// connection goes to the worker that is ready. Mid-turn, the worker holding the
// run drains (it leaves the Service but keeps its open sockets), and the turn's
// next request needs a new connection once the worker closes its idle one. That
// lands on the other worker, which does not hold the connection: the run must
// end naming the cut, not with the transport's 404.

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

/** The stand-in Service: each new connection reaches the worker on `ready`. */
interface Service {
  url: string;
  ready: number;
  /** Resolves the next time the worker on `port` closes a connection. */
  closedBy(port: number): Promise<void>;
  stop(): void;
}

function startService(ready: number): Service {
  const waiting = new Map<number, (() => void)[]>();
  const service: Service = {
    url: "",
    ready,
    closedBy: (port) =>
      new Promise<void>((resolve) => {
        waiting.set(port, [...(waiting.get(port) ?? []), resolve]);
      }),
    stop: () => listener.stop(true),
  };
  type Link = { upstream?: Awaited<ReturnType<typeof Bun.connect>>; pending: Uint8Array[] };
  const listener = Bun.listen<Link>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        client.data = { pending: [] };
        const port = service.ready;
        client.data.upstream = await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            data: (_s, chunk) => {
              client.write(chunk);
            },
            close: () => {
              for (const resolve of waiting.get(port) ?? []) resolve();
              waiting.delete(port);
              client.end();
            },
          },
        });
        for (const chunk of client.data.pending) client.data.upstream.write(chunk);
      },
      data(client, chunk) {
        if (client.data.upstream) client.data.upstream.write(chunk);
        else client.data.pending.push(new Uint8Array(chunk));
      },
      close(client) {
        client.data.upstream?.end();
      },
    },
  });
  service.url = `http://127.0.0.1:${listener.port}/acp`;
  return service;
}

let fake: FakeAnthropic;
let first: ServedWorker;
let second: ServedWorker;
let service: Service;

beforeAll(async () => {
  fake = startFakeAnthropic({ toolInput: '{"orderId":"8812"}' });
  const env = {
    NB_AGENT_AUTH: "none",
    NB_AGENT_MODEL: MODEL,
    NB_AGENT_DRAIN_MS: "60000",
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: fake.baseUrl,
  };
  [first, second] = await Promise.all([startWorker(env), startWorker(env)]);
  service = startService(first.port);
});

afterAll(async () => {
  service?.stop();
  for (const worker of [first, second]) {
    worker?.proc.kill("SIGKILL");
    await worker?.proc.exited;
  }
  await fake?.close();
});

describe("a worker that drains mid-turn", () => {
  test("ends the run as a lost connection, with a message that says so", async () => {
    const run: ResolvedRun = {
      runId: "run_drained",
      conversationId: null,
      system: "You are an order assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "Where is order 8812?" }] }],
      tools: [LOOKUP_ORDER],
      config: { model: MODEL, maxIterations: 5, maxInputTokens: 100_000, maxOutputTokens: 1_000 },
    };
    const runtime = createAcpRuntime(
      "pool",
      createNimbleBrainAgentDriver(),
      createHttpConnection({ url: service.url, credential: null }),
    );
    // The tool runs while a rollout drains the worker holding the run: it
    // leaves the Service, and the tool returns once the worker has closed an
    // idle connection, so the result must travel on a new one.
    const router = new StaticToolRouter([LOOKUP_ORDER], async () => {
      const idleClosed = service.closedBy(first.port);
      first.proc.kill("SIGTERM");
      service.ready = second.port;
      await idleClosed;
      return { content: [{ type: "text", text: "shipped Oct 20" }], isError: false };
    });
    const events: EngineEvent[] = [];

    const failure = await runtime
      .execute(run, {
        tools: router,
        events: { emit: (e) => events.push(e) },
        billSummary: () => {},
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(failure).toBeInstanceOf(AgentConnectionLostError);
    expect((failure as Error).message).toMatch(/restarted mid-turn.*Try again/);
    const errors = events.filter((e): e is EngineEventOf<"run.error"> => e.type === "run.error");
    expect(errors.map((e) => e.data.type)).toEqual(["AgentConnectionLostError"]);
    // The tool ran before the cut, which is why the run is not retried here.
    expect(events.some((e) => e.type === "tool.done")).toBe(true);
  }, 30_000);
});
