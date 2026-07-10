import { describe, expect, test } from "bun:test";
import { extractText, textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createSystemTools } from "../../src/tools/system-tools.ts";
import type { Tool, ToolSource } from "../../src/tools/types.ts";

/**
 * Resilience guard around `nb__status(scope="bundles")`. The status/health
 * report iterates every registered source and enumerates its tools. A source
 * in `starting` / `pending_auth` / `dead` state has `client === null` and
 * throws `<name> not started` from `McpSource.tools()`. Reporting health is
 * precisely where a down connector must be SURFACED — it must not abort the
 * whole report. Without per-source containment one dead connector's throw
 * rejects the entire `scope="bundles"` call, and the tool's top-level catch
 * then replaces every connector's status with that single error.
 *
 * Sibling of `registry-tool-enumeration-resilience.test.ts`, which guards the
 * chat-turn tool list; this guards the status surface.
 */

class HealthySource implements ToolSource {
  constructor(readonly name: string) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    return [
      { name: `${this.name}__ping`, description: "ping", inputSchema: {}, source: this.name },
      { name: `${this.name}__pong`, description: "pong", inputSchema: {}, source: this.name },
    ];
  }
  async execute(toolName: string): Promise<ToolResult> {
    return { content: textContent(`ok ${toolName}`), isError: false };
  }
}

class BrokenSource implements ToolSource {
  constructor(readonly name: string) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async tools(): Promise<Tool[]> {
    // Mirrors the production failure shape: McpSource throws this string
    // when its SDK Client hasn't connected (pending OAuth, dead transport).
    throw new Error(`McpSource "${this.name}" not started`);
  }
  async execute(): Promise<ToolResult> {
    return { content: textContent("unreachable"), isError: true };
  }
}

describe("nb__status scope=bundles — error containment", () => {
  test("a source whose tools() throws is reported, healthy sources still render", async () => {
    const registry = new ToolRegistry();
    registry.addSource(new HealthySource("svc-healthy"));
    registry.addSource(new BrokenSource("svc-broken"));
    const systemTools = await createSystemTools(() => registry);

    // `name: "svc"` matches both sources (the non-McpSource filter only
    // applies to the unfiltered path, so a query is needed to render the
    // plain test doubles here).
    const result = await systemTools.execute("status", { scope: "bundles", name: "svc" });

    // The whole call succeeds rather than collapsing into the top-level
    // "Failed to get status" error.
    expect(result.isError).toBe(false);
    const text = extractText(result.content);
    // The healthy connector still renders with its tool count.
    expect(text).toContain("svc-healthy");
    expect(text).toContain("Tools: 2");
    // The broken connector is present in the report (contained, not aborting).
    expect(text).toContain("svc-broken");
  });

  test("a lone broken source does not fail the whole status call", async () => {
    const registry = new ToolRegistry();
    registry.addSource(new BrokenSource("svc-broken"));
    const systemTools = await createSystemTools(() => registry);

    const result = await systemTools.execute("status", { scope: "bundles", name: "svc-broken" });

    expect(result.isError).toBe(false);
    const text = extractText(result.content);
    expect(text).toContain("svc-broken");
    // The raw "not started" throw never becomes the whole-call error.
    expect(text).not.toContain("Failed to get status");
  });
});
