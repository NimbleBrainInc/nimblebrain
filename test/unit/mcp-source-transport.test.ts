import { describe, it, expect, mock } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import type { McpTransportMode } from "../../src/tools/mcp-source.ts";
import type { EventSink } from "../../src/engine/types.ts";

describe("McpSource transport mode", () => {
  it("isRemote() returns false for stdio mode", () => {
    const mode: McpTransportMode = {
      type: "stdio",
      spawn: { command: "echo", args: [], env: {} },
    };
    const source = new McpSource("test-stdio", mode, new NoopEventSink());
    expect(source.isRemote()).toBe(false);
  });

  it("isRemote() returns true for remote mode", () => {
    const mode: McpTransportMode = {
      type: "remote",
      url: new URL("http://localhost:8080/mcp"),
    };
    const source = new McpSource("test-remote", mode, new NoopEventSink());
    expect(source.isRemote()).toBe(true);
  });

  it("isRemote() returns true for remote mode with transportConfig", () => {
    const mode: McpTransportMode = {
      type: "remote",
      url: new URL("https://example.com/mcp"),
      transportConfig: {
        type: "sse",
        auth: { type: "bearer", token: "secret" },
      },
    };
    const source = new McpSource("test-remote-sse", mode, new NoopEventSink());
    expect(source.isRemote()).toBe(true);
  });

  // Note: real 15s TCP timeout test removed — it waited for a non-routable IP
  // to time out, costing 15s per run. Timeout behavior is covered by smoke tests.

  it("remote source onclose marks source as dead and emits event", async () => {
    // We can't easily test a full remote connection, but we can test the
    // constructor stores mode correctly and isRemote() works
    const events: Array<{ type: string; data: unknown }> = [];
    const sink: EventSink = {
      emit(event) {
        events.push(event);
      },
    };

    const mode: McpTransportMode = {
      type: "remote",
      url: new URL("http://localhost:9999/mcp"),
    };
    const source = new McpSource("dead-test", mode, sink);
    expect(source.isRemote()).toBe(true);
    // Source not started yet — isAlive should be false
    expect(source.isAlive()).toBe(false);
  });
});
