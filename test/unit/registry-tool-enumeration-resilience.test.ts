import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { log } from "../../src/cli/log.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";

/**
 * Resilience guard around `ToolRegistry.availableTools()`. The agent
 * loop calls this on every chat turn to assemble the tool list for the
 * LLM. A single bad source (notably a remote OAuth bundle in
 * `pending_auth` / `starting` state with `this.client === null` —
 * `McpSource.tools()` throws `<name> not started` in that case) MUST
 * NOT take down the whole list. Every other workspace tool stays
 * usable; the broken connector's status is already surfaced on the
 * Connectors / Configure page.
 */

class HealthySource implements ToolSource {
  readonly name = "healthy";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    return [
      {
        name: "healthy__ping",
        description: "ping",
        inputSchema: {},
        source: this.name,
      },
      {
        name: "healthy__pong",
        description: "pong",
        inputSchema: {},
        source: this.name,
      },
    ];
  }
  async execute(toolName: string): Promise<ToolResult> {
    return { content: textContent(`ok ${toolName}`), isError: false };
  }
}

class BrokenSource implements ToolSource {
  readonly name = "broken";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    // Mirrors the production failure shape: McpSource throws this
    // string when its SDK Client hasn't connected (pending OAuth,
    // dead transport, etc.).
    throw new Error(`McpSource "${this.name}" not started`);
  }
  async execute(): Promise<ToolResult> {
    return { content: textContent("unreachable"), isError: true };
  }
}

describe("ToolRegistry.availableTools — error containment", () => {
  test("a source whose tools() throws is skipped, healthy tools survive", async () => {
    const registry = new ToolRegistry();
    registry.addSource(new HealthySource());
    registry.addSource(new BrokenSource());

    const tools = await registry.availableTools();

    // Healthy source's two tools are present; broken source contributes nothing.
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["healthy__ping", "healthy__pong"]);
  });

  test("a source whose tools() throws does not propagate the error", async () => {
    const registry = new ToolRegistry();
    registry.addSource(new BrokenSource());

    // The whole call resolves rather than rejects — that's the
    // chat-stays-up guarantee the agent loop relies on.
    await expect(registry.availableTools()).resolves.toEqual([]);
  });
});

/**
 * Issue #194: the per-skip log must not be `log.warn`. A connector
 * stuck in a broken state would otherwise emit one warn per
 * `availableTools()` call — once per chat turn — flooding operator
 * stderr and any alerting that hooks the warn rate. The operator
 * signal lives at the lifecycle transition site (one warn per
 * non-broken → broken edge); this site is per-turn and must stay
 * silent at warn level.
 */
describe("ToolRegistry.availableTools — log noise", () => {
  let warnCalls: string[];
  let originalWarn: (msg: string) => void;

  beforeEach(() => {
    warnCalls = [];
    originalWarn = log.warn;
    log.warn = (msg) => {
      warnCalls.push(msg);
    };
  });

  afterEach(() => {
    log.warn = originalWarn;
  });

  test("repeated enumeration of a broken source emits zero warns", async () => {
    const registry = new ToolRegistry();
    registry.addSource(new BrokenSource());

    for (let i = 0; i < 100; i++) {
      await registry.availableTools();
    }

    expect(warnCalls.length).toBe(0);
  });

  test("mixed healthy + broken source enumeration also stays quiet at warn", async () => {
    const registry = new ToolRegistry();
    registry.addSource(new HealthySource());
    registry.addSource(new BrokenSource());

    for (let i = 0; i < 25; i++) {
      await registry.availableTools();
    }

    expect(warnCalls.length).toBe(0);
  });
});
