/**
 * `defineInProcessApp` contract tests.
 *
 * `defineInProcessApp` is the base layer every in-process platform source
 * (files, conversations, automations, home, settings, usage, nb) is built
 * on. These tests verify the guarantees the helper enforces for its
 * handlers, so the same class of bug can't recur in one source after
 * another:
 *
 *  - The declared `inputSchema` is enforced before handlers run — missing
 *    or wrongly-typed params never reach fs/Buffer/etc. as Node-internal
 *    errors.
 *  - Unknown tool names return a structured `isError: true` result that
 *    lists the real ones, rather than crashing the in-process server.
 *  - Tools with permissive schemas still pass through.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { textContent } from "../../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../../src/engine/types.ts";
import {
  defineInProcessApp,
  type InProcessResource,
  type InProcessTool,
} from "../../../src/tools/in-process-app.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";

// ── Helpers ────────────────────────────────────────────────────────

function okResult(payload: object): ToolResult {
  return { content: textContent(JSON.stringify(payload)), isError: false };
}

function parseFirst(result: ToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text block");
  return JSON.parse(first.text);
}

function makeSpy(returnValue: ToolResult = okResult({ ok: true })) {
  const calls: Array<Record<string, unknown>> = [];
  const handler = async (input: Record<string, unknown>): Promise<ToolResult> => {
    calls.push(input);
    return returnValue;
  };
  return { handler, calls };
}

function createDef(handler: InProcessTool["handler"]): InProcessTool {
  return {
    name: "create",
    description: "Create a thing.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string" },
        base64_data: { type: "string" },
        mime_type: { type: "string" },
      },
      required: ["filename", "base64_data", "mime_type"],
    },
    handler,
  };
}

async function buildSource(name: string, tools: InProcessTool[]): Promise<McpSource> {
  const source = defineInProcessApp(
    { name, version: "1.0.0", tools },
    new NoopEventSink(),
  );
  await source.start();
  return source;
}

// ── Schema validation ─────────────────────────────────────────────

describe("defineInProcessApp — schema validation", () => {
  let source: McpSource | undefined;
  afterEach(async () => {
    if (source) await source.stop();
    source = undefined;
  });

  test("blocks handler when a required field is missing", async () => {
    const { handler, calls } = makeSpy();
    source = await buildSource("test", [createDef(handler)]);

    const result = await source.execute("create", {});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain('Invalid arguments for "create"');
    expect(body.error).toContain("filename");
    // No Node internals leak
    expect(body.error).not.toContain("Buffer");
    expect(body.error).not.toContain("fs.");
  });

  test("blocks handler when a field has the wrong type", async () => {
    const { handler, calls } = makeSpy();
    source = await buildSource("test", [createDef(handler)]);

    const result = await source.execute("create", {
      filename: "x.txt",
      base64_data: 12345, // number, not string
      mime_type: "text/plain",
    });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain("base64_data");
    expect(body.error).not.toContain("Buffer");
  });

  test("passes through to the handler when input satisfies the schema", async () => {
    const { handler, calls } = makeSpy(okResult({ id: "fl_abc" }));
    source = await buildSource("test", [createDef(handler)]);

    const result = await source.execute("create", {
      filename: "x.txt",
      base64_data: "aGVsbG8=",
      mime_type: "text/plain",
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ filename: "x.txt", base64_data: "aGVsbG8=", mime_type: "text/plain" }]);
  });

  test("skips validation for tools with no declared constraints", async () => {
    const { handler, calls } = makeSpy(okResult({ files: [], total: 0 }));
    source = await buildSource("test", [
      {
        name: "list",
        description: "List things.",
        // No properties, no required — intentionally permissive.
        inputSchema: { type: "object" },
        handler,
      },
    ]);

    const result = await source.execute("list", {});

    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

// ── Unknown tool ──────────────────────────────────────────────────

describe("defineInProcessApp — unknown tool", () => {
  let source: McpSource | undefined;
  afterEach(async () => {
    if (source) await source.stop();
    source = undefined;
  });

  test("returns structured error listing available tools", async () => {
    const { handler } = makeSpy();
    source = await buildSource("files", [
      createDef(handler),
      {
        name: "read",
        description: "Read.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler,
      },
    ]);

    const result = await source.execute("destroy", { id: "x" });

    expect(result.isError).toBe(true);
    const body = parseFirst(result) as { error: string };
    expect(body.error).toContain('Unknown tool "destroy"');
    expect(body.error).toContain('source "files"');
    expect(body.error).toContain("create");
    expect(body.error).toContain("read");
  });
});

// ── Resource notifications ────────────────────────────────────────

describe("McpSource — resource notifications", () => {
  let source: McpSource | undefined;
  afterEach(async () => {
    if (source) await source.stop();
    source = undefined;
  });

  /**
   * Build an in-process source with at least one static resource so the
   * server advertises the `resources` capability — the SDK's
   * `assertNotificationCapability` requires it before allowing
   * `notifications/resources/*` to leave the server.
   */
  async function buildResourceSource(name: string): Promise<McpSource> {
    const resources = new Map<string, InProcessResource>([
      ["instructions://workspace", "<p>hi</p>"],
    ]);
    const built = defineInProcessApp(
      {
        name,
        version: "1.0.0",
        tools: [],
        resources,
      },
      new NoopEventSink(),
    );
    await built.start();
    return built;
  }

  test("notifyResourceListChanged() emits notifications/resources/list_changed to the connected client", async () => {
    source = await buildResourceSource("notify-list");
    const client = source.getClient();
    expect(client).not.toBeNull();

    const received: Array<unknown> = [];
    client!.setNotificationHandler(ResourceListChangedNotificationSchema, async (n) => {
      received.push(n);
    });

    source.notifyResourceListChanged();

    // Notifications cross the InMemoryTransport pair on the next microtask;
    // a single tick is enough to settle delivery.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    const first = received[0] as { method: string };
    expect(first.method).toBe("notifications/resources/list_changed");
  });

  test("notifyResourceUpdated(uri) emits notifications/resources/updated with the URI in params", async () => {
    source = await buildResourceSource("notify-updated");
    const client = source.getClient();
    expect(client).not.toBeNull();

    const received: Array<{ method: string; params?: { uri?: string } }> = [];
    client!.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
      received.push(n as { method: string; params?: { uri?: string } });
    });

    source.notifyResourceUpdated("foo://bar");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("notifications/resources/updated");
    expect(received[0]!.params?.uri).toBe("foo://bar");
  });

  test("notify methods are no-ops on a never-started source", () => {
    const fresh = defineInProcessApp(
      {
        name: "never-started",
        version: "1.0.0",
        tools: [],
        resources: new Map<string, InProcessResource>([["x://y", "<p/>"]]),
      },
      new NoopEventSink(),
    );

    expect(() => fresh.notifyResourceListChanged()).not.toThrow();
    expect(() => fresh.notifyResourceUpdated("x://y")).not.toThrow();
  });

  test("notify methods are no-ops after the source has been stopped", async () => {
    const stopped = await buildResourceSource("notify-stopped");
    await stopped.stop();

    expect(() => stopped.notifyResourceListChanged()).not.toThrow();
    expect(() => stopped.notifyResourceUpdated("x://y")).not.toThrow();
  });
});

// ── Parametric resources (templates / dynamic list / handler) ─────

describe("defineInProcessApp — parametric resources", () => {
  let source: McpSource | undefined;
  afterEach(async () => {
    if (source) await source.stop();
    source = undefined;
  });

  test("listResources entries are merged into resources/list alongside static map entries", async () => {
    const staticMap = new Map<string, InProcessResource>([
      ["instructions://workspace", { text: "ws body", mimeType: "text/markdown" }],
    ]);
    source = defineInProcessApp(
      {
        name: "params-list",
        version: "1.0.0",
        tools: [],
        resources: staticMap,
        listResources: async () => [
          { uri: "instructions://bundles/foo", mimeType: "text/markdown" },
          { uri: "instructions://bundles/bar", name: "bar custom" },
        ],
      },
      new NoopEventSink(),
    );
    await source.start();

    const result = await source.getClient()!.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toEqual([
      "instructions://workspace",
      "instructions://bundles/foo",
      "instructions://bundles/bar",
    ]);

    const fooEntry = result.resources.find((r) => r.uri === "instructions://bundles/foo");
    expect(fooEntry?.mimeType).toBe("text/markdown");
    // Dynamic entry without `name` defaults to its URI, matching static-map behavior.
    expect(fooEntry?.name).toBe("instructions://bundles/foo");

    const barEntry = result.resources.find((r) => r.uri === "instructions://bundles/bar");
    expect(barEntry?.name).toBe("bar custom");
  });

  test("resourceHandler resolves a parametric URI when the static map misses", async () => {
    source = defineInProcessApp(
      {
        name: "params-handler",
        version: "1.0.0",
        tools: [],
        resourceHandler: async (uri) => {
          if (uri.startsWith("instructions://bundles/")) {
            const bundle = uri.slice("instructions://bundles/".length);
            return { text: `body for ${bundle}`, mimeType: "text/markdown" };
          }
          return null;
        },
      },
      new NoopEventSink(),
    );
    await source.start();

    const result = await source
      .getClient()!
      .readResource({ uri: "instructions://bundles/ipinfo" });
    expect(result.contents).toHaveLength(1);
    const first = result.contents[0]!;
    expect(first.uri).toBe("instructions://bundles/ipinfo");
    expect(first.text).toBe("body for ipinfo");
    expect(first.mimeType).toBe("text/markdown");
  });

  test("resourceHandler returning null raises McpError with InvalidParams", async () => {
    source = defineInProcessApp(
      {
        name: "params-miss",
        version: "1.0.0",
        tools: [],
        resourceHandler: async () => null,
      },
      new NoopEventSink(),
    );
    await source.start();

    let captured: unknown;
    try {
      await source.getClient()!.readResource({ uri: "instructions://bundles/missing" });
    } catch (err) {
      captured = err;
    }
    // The SDK rethrows server-side McpError with the same code on the client.
    const e = captured as { code?: number; message?: string } | undefined;
    expect(e).toBeDefined();
    // ErrorCode.InvalidParams === -32602
    expect(e?.code).toBe(-32602);
    expect(String(e?.message ?? "")).toContain("Resource not found: instructions://bundles/missing");
  });

  test("static map miss with no resourceHandler still raises InvalidParams (regression)", async () => {
    source = defineInProcessApp(
      {
        name: "static-only",
        version: "1.0.0",
        tools: [],
        resources: new Map<string, InProcessResource>([["a://b", "<p/>"]]),
      },
      new NoopEventSink(),
    );
    await source.start();

    let captured: unknown;
    try {
      await source.getClient()!.readResource({ uri: "a://nope" });
    } catch (err) {
      captured = err;
    }
    const e = captured as { code?: number } | undefined;
    expect(e?.code).toBe(-32602);
  });

  test("templates are returned by resources/templates/list", async () => {
    source = defineInProcessApp(
      {
        name: "params-templates",
        version: "1.0.0",
        tools: [],
        templates: [
          {
            uriTemplate: "instructions://bundles/{name}",
            name: "Bundle instructions",
            description: "Per-bundle instruction overlay",
            mimeType: "text/markdown",
          },
          {
            uriTemplate: "prompt://composed/{name}",
            name: "Composed prompt",
          },
        ],
      },
      new NoopEventSink(),
    );
    await source.start();

    const result = await source.getClient()!.listResourceTemplates();
    expect(result.resourceTemplates).toHaveLength(2);
    const first = result.resourceTemplates[0]!;
    expect(first.uriTemplate).toBe("instructions://bundles/{name}");
    expect(first.name).toBe("Bundle instructions");
    expect(first.description).toBe("Per-bundle instruction overlay");
    expect(first.mimeType).toBe("text/markdown");

    const second = result.resourceTemplates[1]!;
    expect(second.uriTemplate).toBe("prompt://composed/{name}");
    // Optional fields omitted when not supplied.
    expect(second.description).toBeUndefined();
    expect(second.mimeType).toBeUndefined();
  });

  test("sources without templates do NOT register the templates handler — SDK rejects with MethodNotFound", async () => {
    source = defineInProcessApp(
      {
        name: "no-templates",
        version: "1.0.0",
        tools: [],
        resources: new Map<string, InProcessResource>([["a://b", "<p/>"]]),
      },
      new NoopEventSink(),
    );
    await source.start();

    let captured: unknown;
    try {
      await source.getClient()!.listResourceTemplates();
    } catch (err) {
      captured = err;
    }
    const e = captured as { code?: number } | undefined;
    expect(e).toBeDefined();
    // ErrorCode.MethodNotFound === -32601
    expect(e?.code).toBe(-32601);
  });

  test("InProcessResource.text callback form is awaited and returned on resources/read", async () => {
    let calls = 0;
    const lazy: InProcessResource = {
      mimeType: "text/markdown",
      text: async () => {
        calls += 1;
        return `lazy body ${calls}`;
      },
    };
    source = defineInProcessApp(
      {
        name: "lazy-text",
        version: "1.0.0",
        tools: [],
        resources: new Map<string, InProcessResource>([["prompt://composed/foo", lazy]]),
      },
      new NoopEventSink(),
    );
    await source.start();

    const first = await source.getClient()!.readResource({ uri: "prompt://composed/foo" });
    expect(first.contents[0]?.text).toBe("lazy body 1");

    // Each read invokes the callback again — body assembled per request.
    const second = await source.getClient()!.readResource({ uri: "prompt://composed/foo" });
    expect(second.contents[0]?.text).toBe("lazy body 2");
    expect(calls).toBe(2);
  });

  test("string-literal resource form continues to type-check and serve as text/html", async () => {
    // This test exists to lock in the zero-breaking guarantee — string
    // resources are the most common existing shape across platform sources.
    source = defineInProcessApp(
      {
        name: "html-string",
        version: "1.0.0",
        tools: [],
        resources: new Map<string, InProcessResource>([
          ["ui://settings/panel", "<p>panel</p>"],
        ]),
      },
      new NoopEventSink(),
    );
    await source.start();

    const result = await source.getClient()!.readResource({ uri: "ui://settings/panel" });
    expect(result.contents[0]?.text).toBe("<p>panel</p>");
    expect(result.contents[0]?.mimeType).toBe("text/html");
  });

  test("source with no resource fields does not advertise resources capability", async () => {
    source = defineInProcessApp(
      {
        name: "no-resources",
        version: "1.0.0",
        tools: [],
      },
      new NoopEventSink(),
    );
    await source.start();

    // The server didn't register resources/* handlers — listResources should
    // be rejected with MethodNotFound. (Capabilities are also unset on the
    // initialize response, but the absence of the handler is the observable
    // contract clients react to.)
    let captured: unknown;
    try {
      await source.getClient()!.listResources();
    } catch (err) {
      captured = err;
    }
    const e = captured as { code?: number } | undefined;
    expect(e?.code).toBe(-32601);
  });
});
