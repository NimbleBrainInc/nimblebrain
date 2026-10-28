import { afterEach, expect, test } from "bun:test";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import { createAcpRuntime } from "../../../src/execution/acp/acp-runtime.ts";
import { createNimbleBrainAgentDriver } from "../../../src/execution/acp/drivers/nimblebrain-agent.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";

// A worker that accepts the connection and never answers it.
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

test("cancelling while the worker stalls on initialize aborts the request and ends the run", async () => {
  let reached!: () => void;
  const requested = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let requestAborted = false;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      reached();
      return new Promise<Response>((resolve) => {
        req.signal.addEventListener("abort", () => {
          requestAborted = true;
          resolve(new Response(null, { status: 499 }));
        });
      });
    },
  });
  const controller = new AbortController();
  const run: ResolvedRun = {
    runId: "run_stall",
    conversationId: null,
    system: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    config: {
      model: "test:echo",
      maxIterations: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 100,
      signal: controller.signal,
    },
  };
  const runtime = createAcpRuntime(
    "worker",
    createNimbleBrainAgentDriver({
      id: "worker",
      url: `http://127.0.0.1:${server.port}/acp`,
      connectionCredential: null,
    }),
  );

  const execution = runtime.execute(run, {
    tools: new StaticToolRouter([], () => ({ content: [], isError: false })),
    events: { emit: () => {} },
    billSummary: () => {},
  });
  await requested;
  controller.abort();

  const settled = await Promise.race([
    execution.then(
      () => "resolved",
      () => "rejected",
    ),
    Bun.sleep(2000).then(() => "pending"),
  ]);
  expect(settled).toBe("rejected");
  await Bun.sleep(50);
  expect(requestAborted).toBe(true);
});
