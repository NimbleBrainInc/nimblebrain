/**
 * `ai.nimblebrain/resource-arguments` through the real call path: an `McpSource`
 * dispatching a `tools/call` to a connector whose tool declares a resource
 * argument, with the resolver reading from a second connector over its own
 * `resources/read`. Both connectors are in-process servers on 2025-era
 * in-memory transports; the 2026-07-28 wire is covered over HTTP in
 * `test/integration/resource-arguments.test.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import type { EventSink } from "../../src/engine/types.ts";
import {
  createResourceArgumentsResolver,
  RESOURCE_ARGUMENTS_EXTENSION_ID,
  TokenBucketRateLimit,
} from "../../src/host-resources/index.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { isReservedResourceScheme } from "../../src/tools/resource-schemes.ts";
import { mcpSourceInternals } from "../helpers/mcp-source-internals.ts";

const NoopSink: EventSink = { emit: () => {} };
const WS = "ws_00000000000c0de1";
const SIGNAL = '{"id":42,"observedAt":"2026-10-01"}';

async function linked(server: Server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

/** A connector serving `crm://signals/{id}`. */
function crmServer(): Server {
  const server = new Server({ name: "crm", version: "0.0.1" }, { capabilities: { resources: {} } });
  server.setRequestHandler("resources/templates/list", async () => ({
    resourceTemplates: [{ uriTemplate: "crm://signals/{id}", name: "signal" }],
  }));
  server.setRequestHandler("resources/read", async (request) => {
    if (request.params.uri !== "crm://signals/42") {
      throw new Error("not found");
    }
    return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: SIGNAL }] };
  });
  return server;
}

/** A connector whose `cite` tool declares `citations` as `crm` URIs, and echoes the call's `_meta` back. */
function outboundServer(): Server {
  const server = new Server(
    { name: "outbound", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "cite",
        inputSchema: {
          type: "object" as const,
          properties: { citations: { type: "array", items: { type: "string" } } },
        },
        _meta: {
          [RESOURCE_ARGUMENTS_EXTENSION_ID]: { arguments: { citations: { schemes: ["crm"] } } },
        },
      },
      { name: "plain", inputSchema: { type: "object" as const, properties: {} } },
    ],
  }));
  server.setRequestHandler("tools/call", async (request) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(request.params._meta?.[RESOURCE_ARGUMENTS_EXTENSION_ID] ?? null),
      },
    ],
  }));
  return server;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.find((c) => c.type === "text")?.text ?? "";
}

describe("McpSource resource arguments", () => {
  const started: McpSource[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.stop()));
  });

  async function setUp(opts: { withResolver: boolean }) {
    const crm = new McpSource(
      "crm",
      { type: "inProcess", createServer: async () => linked(crmServer()) },
      NoopSink,
    );
    await crm.start();
    started.push(crm);
    const rateLimit = new TokenBucketRateLimit();
    const resolver = createResourceArgumentsResolver({
      sourcesOf: (wsId) => (wsId === WS ? [crm] : []),
      isHostScheme: isReservedResourceScheme,
      rateLimit,
    });
    const outbound = new McpSource(
      "outbound",
      { type: "inProcess", createServer: async () => linked(outboundServer()) },
      NoopSink,
      {
        workspaceId: WS,
        connectorId: "outbound",
        hostResources: {
          read: async () => ({ contents: [] }),
          list: async () => ({ resources: [] }),
        },
        rateLimit,
        ...(opts.withResolver ? { resourceArguments: resolver } : {}),
      },
    );
    await outbound.start();
    await outbound.tools();
    started.push(outbound);
    return outbound;
  }

  it("hands the tool each declared URI's contents, or its error, in the call's _meta", async () => {
    const outbound = await setUp({ withResolver: true });
    const result = await outbound.execute("cite", {
      citations: ["crm://signals/42", "crm://signals/7", "mail://inbox/1"],
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(textOf(result))).toEqual({
      "crm://signals/42": {
        contents: [{ uri: "crm://signals/42", mimeType: "application/json", text: SIGNAL }],
      },
      "crm://signals/7": { error: { code: "not_found", message: expect.any(String) } },
      "mail://inbox/1": { error: { code: "scheme_not_declared", message: expect.any(String) } },
    });
  });

  it("reads nothing inside a run whose tool limit excludes nb__read_resource", async () => {
    const outbound = await setUp({ withResolver: true });
    const limited = await outbound.execute("cite", { citations: ["crm://signals/42"] }, undefined, {
      isToolAllowed: (name) => name.startsWith("outbound__"),
    });
    expect(JSON.parse(textOf(limited))).toEqual({
      "crm://signals/42": { error: { code: "not_found", message: expect.any(String) } },
    });

    const reading = await outbound.execute("cite", { citations: ["crm://signals/42"] }, undefined, {
      isToolAllowed: (name) => name === "nb__read_resource",
    });
    expect(JSON.parse(textOf(reading))["crm://signals/42"].contents[0].text).toBe(SIGNAL);
  });

  it("resolves the entries itself on a task started directly, with no meta given", async () => {
    const outbound = await setUp({ withResolver: true });
    const owner = { workspaceId: WS, identityId: "user_1" };
    const start = await outbound.startToolAsTask(
      "cite",
      { citations: ["crm://signals/42"] },
      { ownerContext: owner },
    );
    const result = await outbound.awaitToolTaskResult(start.task.taskId, { ownerContext: owner });
    const text = result.content.find((c) => c.type === "text");
    expect(
      JSON.parse(text?.type === "text" ? text.text : "")["crm://signals/42"].contents[0].text,
    ).toBe(SIGNAL);
  });

  it("adds nothing to a call to a tool that declares no resource arguments", async () => {
    const outbound = await setUp({ withResolver: true });
    const result = await outbound.execute("plain", {});
    expect(JSON.parse(textOf(result))).toBeNull();
  });

  it("claims the extension only on a connection that resolves it", async () => {
    const withResolver = await setUp({ withResolver: true });
    const claimed = mcpSourceInternals(withResolver).inProcessServer?.getClientCapabilities();
    expect(claimed?.extensions?.[RESOURCE_ARGUMENTS_EXTENSION_ID]).toEqual({
      maxSize: 10 * 1024 * 1024,
      maxUris: 32,
    });

    const without = await setUp({ withResolver: false });
    expect(
      mcpSourceInternals(without).inProcessServer?.getClientCapabilities()?.extensions?.[
        RESOURCE_ARGUMENTS_EXTENSION_ID
      ],
    ).toBeUndefined();
    const result = await without.execute("cite", { citations: ["crm://signals/42"] });
    expect(JSON.parse(textOf(result))).toBeNull();
  });
});
