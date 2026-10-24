import { describe, expect, test } from "bun:test";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import { type EngineEvent, SKILL_ACTIVATED_META_KEY } from "../../../src/engine/types.ts";
import { connectMcpToolRouter } from "../../../src/execution/acp-agent/mcp-tool-router.ts";
import { openToolProjection } from "../../../src/execution/tool-projection.ts";

const router = new StaticToolRouter(
  [
    { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
    {
      name: "app_only",
      description: "A view's tool",
      inputSchema: { type: "object", properties: {} },
      meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "nb__manage_tools",
      description: "Promote",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
);

/** A tools/list on the 2026-07-28 envelope, with the given auth header. */
function listTools(url: string, authorization?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

describe("tool projection", () => {
  test("answers only its own path with its own bearer, and closes for good", async () => {
    const events: EngineEvent[] = [];
    const projection = await openToolProjection({
      runId: "r",
      router,
      events: { emit: (e) => events.push(e) },
    });
    const bearer = projection.headers[0]?.value;
    const origin = new URL(projection.url).origin;

    expect((await listTools(projection.url)).status).toBe(401);
    expect((await listTools(projection.url, "Bearer wrong")).status).toBe(401);
    expect((await listTools(`${origin}/mcp/elsewhere`, bearer)).status).toBe(404);
    expect(new URL(projection.url).hostname).toBe("127.0.0.1");

    await projection.close();
    await expect(listTools(projection.url, bearer)).rejects.toThrow();
  });

  test("lists only what the agent may call: model-visible, and no engine-state tools", async () => {
    const projection = await openToolProjection({ runId: "r", router, events: { emit() {} } });
    const client = await connectMcpToolRouter([
      { name: "nimblebrain", url: projection.url, headers: projection.headers },
    ]);
    try {
      expect((await client.availableTools()).map((t) => t.name)).toEqual(["echo"]);
    } finally {
      await client.close();
      await projection.close();
    }
  });

  test("records a skill activation once per run, and keeps the marker from the agent", async () => {
    const skillRouter = new StaticToolRouter(
      [
        {
          name: "nb__use_skill",
          description: "Load a skill",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      () => ({
        content: [{ type: "text", text: "skill body" }],
        isError: false,
        _meta: {
          [SKILL_ACTIVATED_META_KEY]: { skillName: "house-rules", scope: "workspace", tokens: 12 },
        },
      }),
    );
    const events: EngineEvent[] = [];
    const projection = await openToolProjection({
      runId: "r",
      router: skillRouter,
      events: { emit: (e) => events.push(e) },
    });
    const client = await connectMcpToolRouter([
      { name: "nimblebrain", url: projection.url, headers: projection.headers },
    ]);
    try {
      const first = await client.execute({ id: "a", name: "nb__use_skill", input: {} });
      await client.execute({ id: "b", name: "nb__use_skill", input: {} });
      expect(first._meta).toBeUndefined();
      const activations = events.filter((e) => e.type === "skill.activated");
      expect(activations.map((e) => e.type === "skill.activated" && e.data.skillName)).toEqual([
        "house-rules",
      ]);
    } finally {
      await client.close();
      await projection.close();
    }
  });
});
