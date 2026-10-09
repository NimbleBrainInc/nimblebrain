/**
 * `/mcp/<wsId>` carries the outside client's side of the protocol through to a
 * connector: the client's capabilities decide what the connector asks for, an
 * `input_required` answer reaches the client and the client's answers reach the
 * connector, the connector's `requestState` travels sealed to the caller and
 * the tool and its arguments, an error that asks the client to change its
 * request reaches the client as it is, and progress arrives under the client's
 * own token. Each relayed elicitation names the connector it came from: its
 * catalog title, else its server name. A `prompts/get` carries the same side of
 * the protocol, under a round sealed to the prompt.
 */
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { CATALOG_DIR_ENV } from "../../src/connectors/catalog/catalog.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import { FIRST_PARTY_GRANT, type VerifiedIdentity } from "../../src/identity/provider.ts";
import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeIdentity } from "../helpers/identity.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const OTHER_WORKSPACE_ID = "ws_005c47492e176e75";
/** The header that makes a request the second identity's. */
const OTHER_HEADER = "x-caller-identity";
const OTHER = makeIdentity({ id: "usr_caller_other", orgRole: "member" });

/** The dev provider, except a request carrying {@link OTHER_HEADER} is {@link OTHER}. */
class TwoIdentityProvider extends DevIdentityProvider {
  override async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    if (req.headers.get(OTHER_HEADER)) return { ...OTHER, grant: FIRST_PARTY_GRANT };
    return super.verifyRequest(req);
  }
}
/** A catalog entry naming the same connector under a second server name, by its title. */
const CATALOGED_ID = "ai.example.mail/mcp";
const CATALOGED = slugifyServerName(CATALOGED_ID);
const CATALOGED_TITLE = "Example Mail";

/** The connector's own state, which the client must never hold as it is. */
const CONNECTOR_STATE = "connector-state-1";
const ANSWER = { action: "accept", content: { yes: true } };

/**
 * The connector under test: one tool that asks in form mode, one that asks in
 * URL mode for the `url` it is given, one that needs sampling, one that
 * reports progress, and a prompt named like the first tool that asks as it does.
 */
function buildConnector(): Server {
  const server = new Server(
    { name: "caller-fixture", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {} } },
  );
  server.setRequestHandler("prompts/list", async () => ({ prompts: [{ name: "confirm" }] }));
  server.setRequestHandler("prompts/get", async (_request, ctx) => {
    const answer = ctx.mcpReq.inputResponses?.ok;
    if (!answer) {
      return {
        resultType: "input_required",
        inputRequests: {
          ok: {
            method: "elicitation/create",
            params: {
              message: "Draft the prompt?",
              requestedSchema: { type: "object", properties: { yes: { type: "boolean" } } },
            },
          },
        },
        requestState: CONNECTOR_STATE,
      } as never;
    }
    const state = ctx.mcpReq.requestState<string>();
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `answered:${JSON.stringify(answer)} state:${state}`,
          },
        },
      ],
    };
  });
  const schema = { type: "object" as const, properties: {} };
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      { name: "confirm", inputSchema: schema },
      { name: "confirm_url", inputSchema: schema },
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
      case "confirm_url":
        return {
          resultType: "input_required",
          inputRequests: {
            ok: {
              method: "elicitation/create",
              params: {
                mode: "url",
                message: "Open the page to confirm",
                elicitationId: "e1",
                url: String(request.params.arguments?.url),
              },
            },
          },
        } as never;
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
let priorCatalogDir: string | undefined;

/** An MCP source for the fixture connector, registered under `name`. */
async function fixtureSource(name: string): Promise<McpSource> {
  const source = new McpSource(
    name,
    {
      type: "remote",
      url: new URL(`http://localhost:${connector.port}/mcp`),
      transportConfig: { type: "streamable-http" },
      allowInsecure: true,
    },
    new NoopEventSink(),
  );
  await source.start();
  return source;
}

beforeAll(async () => {
  const handler = createMcpHandler(buildConnector);
  connector = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
  workDir = await mkdtemp(join(tmpdir(), "nb-mcp-caller-"));
  const catalogDir = join(workDir, "catalog");
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(
    join(catalogDir, "mail.yaml"),
    `servers:
  - name: ${CATALOGED_ID}
    title: ${CATALOGED_TITLE}
    description: Test connector
    version: "1.0.0"
    remotes:
      - type: streamable-http
        url: http://localhost:${connector.port}/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: none
`,
  );
  priorCatalogDir = process.env[CATALOG_DIR_ENV];
  process.env[CATALOG_DIR_ENV] = catalogDir;
  runtime = await Runtime.start({
    identityProvider: ({ workDir: dir, userStore }) => new TwoIdentityProvider(dir, userStore),
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
  for (const wsId of [TEST_WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
    await provisionTestWorkspace(runtime, wsId, wsId);
    runtime.getRegistryForWorkspace(wsId).addSource(await fixtureSource("fixture"));
  }
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(await fixtureSource(CATALOGED));
  await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, OTHER.id, "member");
  handle = startServer({ runtime, port: 0 });
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  connector.stop(true);
  if (priorCatalogDir === undefined) delete process.env[CATALOG_DIR_ENV];
  else process.env[CATALOG_DIR_ENV] = priorCatalogDir;
  rmSync(workDir, { recursive: true, force: true });
});

/** The elicitation messages the clients were asked, in order. */
const asked: string[] = [];

/** A client of `/mcp/<wsId>`, answering elicitation when it declares it. */
async function client(
  opts: { elicitation?: boolean; wsId?: string; other?: boolean } = {},
): Promise<Client> {
  const c = newMcpClient(
    { name: "caller-test", version: "1.0.0" },
    { capabilities: opts.elicitation ? { elicitation: { form: {}, url: {} } } : {} },
  );
  if (opts.elicitation) {
    c.setRequestHandler("elicitation/create", async (request) => {
      asked.push(request.params.message);
      return ANSWER as never;
    });
  }
  await c.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://localhost:${handle.port}/mcp/${opts.wsId ?? TEST_WORKSPACE_ID}`),
      opts.other ? { requestInit: { headers: { [OTHER_HEADER]: "1" } } } : {},
    ),
  );
  return c;
}

function text(result: { content?: unknown }): string {
  return (result.content as Array<{ text?: string }>)[0]?.text ?? "";
}

/** A connector's first-round `input_required` answer, as the client receives it. */
async function firstRound(
  c: Client,
  name = "fixture__confirm",
  args: Record<string, unknown> = {},
): Promise<{
  requestState?: string;
  inputRequests?: Record<string, { params: { message: string; url?: string } }>;
}> {
  return (await c.callTool({ name, arguments: args }, { allowInputRequired: true })) as never;
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

  it("names the connector in the relayed form-mode message", async () => {
    const c = await client({ elicitation: true });
    asked.length = 0;
    try {
      await c.callTool({ name: "fixture__confirm", arguments: {} });
      expect(asked).toEqual(["fixture: Proceed?"]);
    } finally {
      await c.close();
    }
  });

  it("relays a URL-mode request naming the connector, an absolute url as it is", async () => {
    const c = await client({ elicitation: true });
    try {
      const url = "https://confirm.example.com/send/1";
      const { inputRequests } = await firstRound(c, "fixture__confirm_url", { url });
      expect(inputRequests?.ok?.params).toMatchObject({
        message: "fixture: Open the page to confirm",
        url,
      });
    } finally {
      await c.close();
    }
  });

  it("names a cataloged connector by its catalog title", async () => {
    const c = await client({ elicitation: true });
    try {
      const { inputRequests } = await firstRound(c, `${CATALOGED}__confirm_url`, {
        url: "https://confirm.example.com/send/1",
      });
      expect(inputRequests?.ok?.params.message).toBe(
        `${CATALOGED_TITLE}: Open the page to confirm`,
      );
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

  it("refuses a sealed state replayed by another member of the workspace", async () => {
    const owner = await client({ elicitation: true });
    const other = await client({ elicitation: true, other: true });
    try {
      const { requestState } = await firstRound(owner);
      await expect(
        other.callTool({
          name: "fixture__confirm",
          arguments: {},
          inputResponses: { ok: ANSWER },
          requestState,
        } as never),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await Promise.all([owner.close(), other.close()]);
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

  it("refuses a sealed state on a call with other arguments", async () => {
    const c = await client({ elicitation: true });
    try {
      const { requestState } = await firstRound(c, "fixture__confirm", { to: "a@example.com" });
      await expect(
        c.callTool({
          name: "fixture__confirm",
          arguments: { to: "b@example.com" },
          inputResponses: { ok: ANSWER },
          requestState,
        } as never),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await c.close();
    }
  });

  it("refuses a sealed state older than ten minutes", async () => {
    const c = await client({ elicitation: true });
    try {
      const { requestState } = await firstRound(c);
      setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
      await expect(
        c.callTool({
          name: "fixture__confirm",
          arguments: {},
          inputResponses: { ok: ANSWER },
          requestState,
        } as never),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      setSystemTime();
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

describe("/mcp/<wsId> carries the caller's side of a prompts/get", () => {
  /** The prompt's first-round `input_required` answer, as the client receives it. */
  async function firstPromptRound(
    c: Client,
    args: Record<string, string> = {},
  ): Promise<{
    requestState?: string;
    inputRequests?: Record<string, { params: { message: string } }>;
  }> {
    return (await c.getPrompt(
      { name: "fixture__confirm", arguments: args },
      { allowInputRequired: true },
    )) as never;
  }

  it("relays the connector's input request naming the connector, and the answer and state back", async () => {
    const c = await client({ elicitation: true });
    asked.length = 0;
    try {
      const result = await c.getPrompt({ name: "fixture__confirm" });
      expect(result.messages[0]?.content).toEqual({
        type: "text",
        text: `answered:${JSON.stringify(ANSWER)} state:${CONNECTOR_STATE}`,
      });
      expect(asked).toEqual(["fixture: Draft the prompt?"]);
    } finally {
      await c.close();
    }
  });

  it("hands the client a sealed state, never the connector's own", async () => {
    const c = await client({ elicitation: true });
    try {
      const { requestState } = await firstPromptRound(c);
      expect(requestState).toBeDefined();
      expect(requestState).not.toBe(CONNECTOR_STATE);
    } finally {
      await c.close();
    }
  });

  it("refuses a prompt's state on another member's retry, with other arguments, or on a tool call", async () => {
    const c = await client({ elicitation: true });
    const other = await client({ elicitation: true, other: true });
    try {
      const { requestState } = await firstPromptRound(c, { topic: "a" });
      const retry = { name: "fixture__confirm", inputResponses: { ok: ANSWER }, requestState };
      await expect(
        other.getPrompt({ ...retry, arguments: { topic: "a" } } as never),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        c.getPrompt({ ...retry, arguments: { topic: "b" } } as never),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        c.callTool({ ...retry, arguments: { topic: "a" } } as never),
      ).rejects.toMatchObject({
        code: -32602,
      });
    } finally {
      await c.close();
      await other.close();
    }
  });

  it("refuses a tool call's state on a prompt of the same name", async () => {
    const c = await client({ elicitation: true });
    try {
      const { requestState } = await firstRound(c);
      await expect(
        c.getPrompt({
          name: "fixture__confirm",
          inputResponses: { ok: ANSWER },
          requestState,
        } as never),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await c.close();
    }
  });
});
