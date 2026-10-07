/**
 * `/mcp/<wsId>` carries the outside client's side of the protocol through to a
 * connector: the client's capabilities decide what the connector asks for, an
 * `input_required` answer reaches the client and the client's answers reach the
 * connector, the connector's `requestState` travels sealed to the caller and
 * the tool, an error that asks the client to change its request reaches the
 * client as it is, and progress arrives under the client's own token.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  MissingRequiredClientCapabilityError,
  Server,
} from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const OTHER_WORKSPACE_ID = "ws_005c47492e176e75";
/** The connector's own state, which the client must never hold as it is. */
const CONNECTOR_STATE = "connector-state-1";
const ANSWER = { action: "accept", content: { yes: true } };

/** The connector under test: one tool that asks, one that needs sampling, one that reports progress. */
function buildConnector(): Server {
  const server = new Server(
    { name: "caller-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const schema = { type: "object" as const, properties: {} };
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      { name: "confirm", inputSchema: schema },
      { name: "needs_sampling", inputSchema: schema },
      { name: "count", inputSchema: schema },
    ],
  }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const capabilities = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[
      CLIENT_CAPABILITIES_META_KEY
    ] as { elicitation?: unknown; sampling?: unknown } | undefined;
    switch (request.params.name) {
      case "confirm": {
        if (!capabilities?.elicitation) {
          return { content: [{ type: "text" as const, text: "no elicitation" }] };
        }
        const answer = ctx.mcpReq.inputResponses?.ok;
        if (!answer) {
          return {
            resultType: "input_required",
            inputRequests: {
              ok: {
                method: "elicitation/create",
                params: {
                  message: "Proceed?",
                  requestedSchema: { type: "object", properties: { yes: { type: "boolean" } } },
                },
              },
            },
            requestState: CONNECTOR_STATE,
          } as never;
        }
        const state = ctx.mcpReq.requestState<string>();
        return {
          content: [
            { type: "text" as const, text: `answered:${JSON.stringify(answer)} state:${state}` },
          ],
        };
      }
      case "needs_sampling":
        if (!capabilities?.sampling) {
          throw new MissingRequiredClientCapabilityError(
            { requiredCapabilities: { sampling: {} } },
            "needs_sampling asks the client for a completion",
          );
        }
        return { content: [{ type: "text" as const, text: "sampled" }] };
      default: {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        if (progressToken !== undefined) {
          for (const progress of [1, 2]) {
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: { progressToken, progress, total: 2 },
            });
          }
        }
        return { content: [{ type: "text" as const, text: "counted" }] };
      }
    }
  });
  return server;
}

let connector: ReturnType<typeof Bun.serve>;
let runtime: Runtime;
let handle: ServerHandle;
let workDir: string;

beforeAll(async () => {
  const handler = createMcpHandler(buildConnector);
  connector = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
  workDir = await mkdtemp(join(tmpdir(), "nb-mcp-caller-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
  for (const wsId of [TEST_WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await provisionTestWorkspace(runtime, wsId, wsId);
    const source = new McpSource(
      "fixture",
      {
        type: "remote",
        url: new URL(`http://localhost:${connector.port}/mcp`),
        transportConfig: { type: "streamable-http" },
        allowInsecure: true,
      },
      new NoopEventSink(),
    );
    await source.start();
    runtime.getRegistryForWorkspace(wsId).addSource(source);
  }
  handle = startServer({ runtime, port: 0 });
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  connector.stop(true);
  rmSync(workDir, { recursive: true, force: true });
});

/** A client of `/mcp/<wsId>`, answering elicitation when it declares it. */
async function client(opts: { elicitation?: boolean; wsId?: string } = {}): Promise<Client> {
  const c = newMcpClient(
    { name: "caller-test", version: "1.0.0" },
    { capabilities: opts.elicitation ? { elicitation: { form: {} } } : {} },
  );
  if (opts.elicitation) c.setRequestHandler("elicitation/create", async () => ANSWER as never);
  await c.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.port}/mcp/${opts.wsId ?? TEST_WORKSPACE_ID}`),
    ),
  );
  return c;
}

function text(result: { content?: unknown }): string {
  return (result.content as Array<{ text?: string }>)[0]?.text ?? "";
}

/** A connector's first-round `input_required` answer, as the client receives it. */
async function firstRound(c: Client): Promise<{ requestState?: string }> {
  return (await c.callTool(
    { name: "fixture__confirm", arguments: {} },
    { allowInputRequired: true },
  )) as { requestState?: string };
}

describe("/mcp/<wsId> carries the caller's side of a connector call", () => {
  it("relays the connector's input request, and the client's answer and the connector's state back", async () => {
    const c = await client({ elicitation: true });
    try {
      const result = await c.callTool({ name: "fixture__confirm", arguments: {} });
      expect(text(result)).toBe(`answered:${JSON.stringify(ANSWER)} state:${CONNECTOR_STATE}`);
    } finally {
      await c.close();
    }
  });

  it("asks nothing of a client that does not declare elicitation", async () => {
    const c = await client();
    try {
      expect(text(await c.callTool({ name: "fixture__confirm", arguments: {} }))).toBe(
        "no elicitation",
      );
    } finally {
      await c.close();
    }
  });

  it("hands the client a sealed state, never the connector's own", async () => {
    const c = await client({ elicitation: true });
    try {
      const { requestState } = await firstRound(c);
      expect(requestState).toBeDefined();
      expect(requestState).not.toBe(CONNECTOR_STATE);
    } finally {
      await c.close();
    }
  });

  it("refuses a sealed state at another workspace's URL", async () => {
    const here = await client({ elicitation: true });
    const there = await client({ elicitation: true, wsId: OTHER_WORKSPACE_ID });
    try {
      const { requestState } = await firstRound(here);
      await expect(
        there.callTool({
          name: "fixture__confirm",
          arguments: {},
          inputResponses: { ok: ANSWER },
          requestState,
        } as never),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await Promise.all([here.close(), there.close()]);
    }
  });

  it("refuses a sealed state on a call to another tool", async () => {
    const c = await client({ elicitation: true });
    try {
      const { requestState } = await firstRound(c);
      await expect(
        c.callTool({ name: "fixture__count", arguments: {}, requestState } as never),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await c.close();
    }
  });

  it("relays the connector's missing-capability error to the client as it is", async () => {
    const c = await client();
    try {
      await expect(
        c.callTool({ name: "fixture__needs_sampling", arguments: {} }),
      ).rejects.toMatchObject({ code: -32021 });
    } finally {
      await c.close();
    }
  });

  it("relays the connector's progress under the client's own token", async () => {
    const c = await client();
    const seen: number[] = [];
    try {
      const result = await c.callTool(
        { name: "fixture__count", arguments: {} },
        { onprogress: (p) => seen.push(p.progress) },
      );
      expect(text(result)).toBe("counted");
      expect(seen).toEqual([1, 2]);
    } finally {
      await c.close();
    }
  });
});
