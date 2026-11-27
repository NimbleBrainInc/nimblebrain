import { describe, expect, test } from "bun:test";
import { StaticToolRouter } from "../../../src/adapters/static-router.ts";
import {
  type ConnectorSkillCandidate,
  type EngineEvent,
  SKILL_ACTIVATED_META_KEY,
  type ToolSchema,
} from "../../../src/engine/types.ts";
import { openToolProjection } from "../../../src/execution/tool-projection.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { createSystemTools } from "../../../src/tools/system-tools.ts";
import { channelMcpServer, connectMcpToolRouter } from "../../helpers/acp/mcp-tool-router.ts";
import { stub } from "../../helpers/stub.ts";

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

describe("tool projection", () => {
  test("lists only what the agent may call: model-visible, and no engine-state tools", async () => {
    const projection = await openToolProjection({ runId: "r", router, events: { emit() {} } });
    const client = await connectMcpToolRouter([
      channelMcpServer("nimblebrain", projection.channel()),
    ]);
    try {
      expect((await client.availableTools()).map((t) => t.name)).toEqual(["echo"]);
    } finally {
      await client.close();
      await projection.close();
    }
  });

  test("an external agent can ask for a plugin: it is served nb__request_plugin, not nb__manage_tools", async () => {
    // The kernel's own `nb` source, as the run's router holds it.
    const registry = new ToolRegistry();
    registry.addSource(await createSystemTools(() => registry, { runtime: stub<Runtime>({}) }));
    const projection = await openToolProjection({
      runId: "r",
      router: registry,
      events: { emit() {} },
    });
    const client = await connectMcpToolRouter([
      channelMcpServer("nimblebrain", projection.channel()),
    ]);
    try {
      const names = (await client.availableTools()).map((t) => t.name);
      expect(names).toContain("nb__request_plugin");
      expect(names).not.toContain("nb__manage_tools");
      // It reaches the request's own handler, which refuses a call with no
      // conversation to ask in.
      const result = await client.execute({
        id: "c1",
        name: "nb__request_plugin",
        input: { plugin: "granola" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("asks the person in a conversation");
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
      channelMcpServer("nimblebrain", projection.channel()),
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
      channelMcpServer("nimblebrain", projection.channel()),
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
      channelMcpServer("nimblebrain", projection.channel()),
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

  test("records why a call failed and that it was held, as the engine records them", async () => {
    // A fetch tool bound to guidance, used for several pages, as an external
    // agent's research run uses it: held, re-issued, then one argument value
    // rejected and corrected on the next call.
    const fetchRouter = new StaticToolRouter(
      [
        {
          name: "fetch",
          description: "Fetch pages",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              mode: { type: "string", enum: ["always", "fallback"] },
            },
          },
          annotations: { readOnlyHint: true },
        },
      ],
      (call) =>
        call.input.url === "https://example.net"
          ? {
              content: [
                { type: "text", text: "A third-party service is temporarily unavailable." },
              ],
              isError: true,
              structuredContent: {
                error: { code: "upstream_unavailable", retryable: true, message: "unavailable" },
              },
            }
          : { content: [{ type: "text", text: "page" }], isError: false },
    );
    const projection = await openToolProjection({
      runId: "r",
      router: fetchRouter,
      events: { emit() {} },
      skills: {
        candidates: [
          {
            name: "fetch-rules",
            body: "Fetch what you cite.",
            scope: "connector",
            toolAffinity: ["fetch"],
          },
        ],
        delivered: [],
      },
    });
    const client = await connectMcpToolRouter([
      channelMcpServer("nimblebrain", projection.channel()),
    ]);
    try {
      await client.execute({ id: "1", name: "fetch", input: { url: "https://example.com" } });
      await client.execute({ id: "2", name: "fetch", input: { url: "https://example.com" } });
      await client.execute({
        id: "3",
        name: "fetch",
        input: { url: "https://example.org", mode: '"always"' },
      });
      await client.execute({
        id: "4",
        name: "fetch",
        input: { url: "https://example.org", mode: "always" },
      });
      await client.execute({ id: "5", name: "fetch", input: { url: "https://example.net" } });

      const calls = projection.calls();
      expect(calls.map((c) => [c.ok, c.errorReason, c.held])).toEqual([
        [false, "skill_guidance_pending", true],
        [true, undefined, undefined],
        [false, "bad_input", undefined],
        [true, undefined, undefined],
        [false, "upstream_unavailable", undefined],
      ]);
    } finally {
      await client.close();
      await projection.close();
    }
  });
});
