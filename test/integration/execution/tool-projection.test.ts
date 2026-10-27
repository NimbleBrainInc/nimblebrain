import { describe, expect, test } from "bun:test";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import {
  type ConnectorSkillCandidate,
  type EngineEvent,
  SKILL_ACTIVATED_META_KEY,
  type ToolSchema,
} from "../../../src/engine/types.ts";
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

  test("a call arriving while another call settles still waits on its guidance", async () => {
    let release: (body: string) => void = () => {};
    let claimed: () => void = () => {};
    const bodyClaimed = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const guide: ConnectorSkillCandidate = {
      name: "write-rules",
      body: "",
      scope: "connector",
      toolAffinity: ["write"],
      loadBody: () => {
        claimed();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const executed: string[] = [];
    const tools: ToolSchema[] = ["write", "other"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    }));
    const concurrentRouter = new StaticToolRouter(tools, (call) => {
      executed.push(call.name);
      return { content: [{ type: "text", text: "ok" }], isError: false };
    });
    let otherDone: () => void = () => {};
    const otherSettling = new Promise<void>((resolve) => {
      otherDone = resolve;
    });
    const projection = await openToolProjection({
      runId: "r",
      router: concurrentRouter,
      events: {
        emit: (e) => {
          if (e.type === "tool.done" && e.data.name === "other") otherDone();
        },
      },
      skills: { candidates: [guide], delivered: [] },
    });
    const client = await connectMcpToolRouter([
      { name: "nimblebrain", url: projection.url, headers: projection.headers },
    ]);
    try {
      // The first write claims the guidance and waits on its body.
      const firstWrite = client.execute({ id: "w1", name: "write", input: {} });
      await bodyClaimed;
      // An unrelated call takes that claim into its settlement, and another
      // settles with nothing, while the body is still on its way.
      const drain = client.execute({ id: "o1", name: "other", input: {} });
      await otherSettling;
      await client.execute({ id: "o2", name: "other", input: {} });
      // A second write now, before the guidance has reached any result, must
      // wait on that body rather than run.
      const secondWrite = client.execute({ id: "w2", name: "write", input: {} });
      await Bun.sleep(100);
      expect(executed).toEqual(["other", "other"]);

      release("Write carefully.");
      const [held, carried] = await Promise.all([firstWrite, drain, secondWrite]);
      expect(held?.isError).toBe(true);
      expect(JSON.stringify(carried?.content)).toContain("Write carefully.");
    } finally {
      await client.close();
      await projection.close();
    }
  });

  test("guidance after a call keeps the call's own non-text output", async () => {
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const imageRouter = new StaticToolRouter(
      [
        {
          name: "shot",
          description: "Screenshot",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
      () => ({ content: [image], isError: false }),
    );
    const projection = await openToolProjection({
      runId: "r",
      router: imageRouter,
      events: { emit() {} },
      skills: {
        candidates: [
          {
            name: "shot-rules",
            body: "Crop tightly.",
            scope: "connector",
            toolAffinity: ["shot"],
            implicitBinding: true,
          },
        ],
        delivered: [],
      },
    });
    const client = await connectMcpToolRouter([
      { name: "nimblebrain", url: projection.url, headers: projection.headers },
    ]);
    try {
      const result = await client.execute({ id: "s", name: "shot", input: {} });
      expect(result.content[0]).toEqual(image);
      expect(result.content.slice(1).map((c) => c.type)).toEqual(["text"]);
      expect(JSON.stringify(result.content[1])).toContain("Crop tightly.");
    } finally {
      await client.close();
      await projection.close();
    }
  });
});
