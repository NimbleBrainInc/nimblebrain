import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import type { EngineEvent } from "../../../src/engine/types.ts";
import {
  createAcpMcpServers,
  MCP_MESSAGE,
  parseMcpMessage,
} from "../../../src/execution/acp/mcp-over-acp.ts";
import { openToolProjection } from "../../../src/execution/tool-projection.ts";

// MCP carried on the ACP connection: the client side routes each `mcp/message`
// to the server it declared, and to nothing else.

const LOOKUP = {
  name: "lookup",
  description: "Look a value up",
  inputSchema: { type: "object", properties: {} },
};

async function projection(
  handler: (signal?: AbortSignal) => Promise<string> = () => Bun.sleep(0).then(() => "42"),
) {
  const events: EngineEvent[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const router = new StaticToolRouter([LOOKUP], () => {
    throw new Error("unreachable");
  });
  router.execute = async (_call, signal) => {
    signals.push(signal);
    return { content: [{ type: "text", text: await handler(signal) }], isError: false };
  };
  const opened = await openToolProjection({
    runId: "r",
    router,
    events: { emit: (e) => events.push(e) },
  });
  return { opened, events, signals };
}

/** A client app serving one declared server, and an agent that sends whatever the test asks. */
async function connected(setUp: (servers: ReturnType<typeof createAcpMcpServers>) => void) {
  const servers = createAcpMcpServers();
  setUp(servers);
  let agent: acp.AgentContext | undefined;
  const app = acp.agent({ name: "t" }).onConnect((connection) => {
    agent = connection.client;
  });
  const connection = servers.serve(acp.client({ name: "c" })).connect(app);
  await Bun.sleep(0);
  if (!agent) throw new Error("agent did not connect");
  return { agent, close: () => connection.close() };
}

const INIT = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "t", version: "1" },
};

describe("mcp/message routing", () => {
  test("a message for the declared server reaches the projection", async () => {
    const { opened } = await projection();
    let serverId = "";
    const { agent, close } = await connected((servers) => {
      const declared = servers.declare("nimblebrain", opened.channel());
      serverId = "serverId" in declared ? declared.serverId : "";
    });
    await agent.request(MCP_MESSAGE, {
      serverId,
      requestId: "1",
      method: "initialize",
      params: INIT,
    });
    await agent.notify(MCP_MESSAGE, { serverId, method: "notifications/initialized" });
    const listed = await agent.request<{ result: { tools: { name: string }[] } }>(MCP_MESSAGE, {
      serverId,
      requestId: "2",
      method: "tools/list",
    });
    expect(listed.result.tools.map((t) => t.name)).toEqual(["lookup"]);
    const called = await agent.request<{ result: { content: { text: string }[] } }>(MCP_MESSAGE, {
      serverId,
      requestId: "3",
      method: "tools/call",
      params: { name: "lookup", arguments: {} },
    });
    expect(called.result.content[0]?.text).toBe("42");
    close();
    await opened.close();
  });

  test("a message for any other server id is refused", async () => {
    const { opened } = await projection();
    const { agent, close } = await connected((servers) => {
      servers.declare("nimblebrain", opened.channel());
    });
    await expect(
      agent.request(MCP_MESSAGE, {
        serverId: "nb_guessed",
        requestId: "1",
        method: "tools/list",
      }),
    ).rejects.toThrow(/unknown MCP server/);
    close();
    await opened.close();
  });

  test("cancelling the mcp/message cancels the tool call it carries", async () => {
    const { opened, events, signals } = await projection(
      (signal) =>
        new Promise<string>((resolve) =>
          signal?.addEventListener("abort", () => resolve("late"), { once: true }),
        ),
    );
    let serverId = "";
    const { agent, close } = await connected((servers) => {
      const declared = servers.declare("nimblebrain", opened.channel());
      serverId = "serverId" in declared ? declared.serverId : "";
    });
    await agent.request(MCP_MESSAGE, {
      serverId,
      requestId: "1",
      method: "initialize",
      params: INIT,
    });
    await agent.notify(MCP_MESSAGE, { serverId, method: "notifications/initialized" });
    const controller = new AbortController();
    const call = agent.request(
      MCP_MESSAGE,
      {
        serverId,
        requestId: "2",
        method: "tools/call",
        params: { name: "lookup", arguments: {} },
      },
      { cancellationSignal: controller.signal },
    );
    while (!events.some((e) => e.type === "tool.start")) await Bun.sleep(1);
    controller.abort();
    expect(await call).toEqual({ error: { code: -32800, message: "request cancelled" } });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    close();
    await opened.close();
  });

  test("a request cancelled before it is sent runs nothing", async () => {
    const { opened, events } = await projection();
    const channel = opened.channel();
    await channel.request("1", "initialize", INIT);
    channel.notify("notifications/initialized", undefined);
    const call = channel.request(
      "2",
      "tools/call",
      { name: "lookup", arguments: {} },
      AbortSignal.abort(),
    );
    expect(await call).toEqual({ error: { code: -32800, message: "request cancelled" } });
    await Bun.sleep(5);
    expect(events.filter((e) => e.type === "tool.start")).toHaveLength(0);
    await opened.close();
  });

  test("a closed run answers what is still in flight", async () => {
    const { opened } = await projection(() => new Promise<string>(() => {}));
    const channel = opened.channel();
    await channel.request("1", "initialize", INIT);
    channel.notify("notifications/initialized", undefined);
    const call = channel.request("2", "tools/call", { name: "lookup", arguments: {} });
    await Bun.sleep(5);
    await opened.close();
    expect(await call).toMatchObject({ error: { code: -32800 } });
    expect(() => opened.channel()).toThrow(/closed/);
  });
});

describe("mcp/message params", () => {
  test("need a server id and a method, a string request id and object params", () => {
    expect(parseMcpMessage({ serverId: "s", method: "m", requestId: "1", params: {} })).toEqual({
      serverId: "s",
      method: "m",
      requestId: "1",
      params: {},
    });
    expect(parseMcpMessage({ serverId: "s", method: "m", params: null })).toEqual({
      serverId: "s",
      method: "m",
    });
    expect(() => parseMcpMessage({ method: "m" })).toThrow(/serverId/);
    expect(() => parseMcpMessage({ serverId: "s", method: "m", requestId: 1 })).toThrow(/string/);
    expect(() => parseMcpMessage({ serverId: "s", method: "m", params: [] })).toThrow(/object/);
  });
});
