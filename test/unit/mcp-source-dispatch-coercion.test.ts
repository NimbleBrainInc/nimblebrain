import { describe, expect, it } from "bun:test";
import type { CallToolResult, Task } from "@modelcontextprotocol/sdk/types.js";
import type { EventSink } from "../../src/engine/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

// Regression coverage for the dispatch-boundary argument normalization in
// McpSource.execute (inline path).
//
// Models routinely emit object/array tool parameters as JSON-encoded strings
// (`to_recipients: "[\"a@b.com\"]"` instead of the array). The upstream
// validator then rejects them ("Input should be a valid list on parameter
// to_recipients"). McpSource.execute coerces such misencodings against the
// server's OWN advertised schema — the authoritative oracle and the one place
// every caller path (agent loop, search-promoted tools, /mcp, delegate)
// converges — before the request reaches the wire. These tests pin that the
// coerced shape, not the model's raw string, is what gets dispatched.

const noopSink: EventSink = { emit: () => {} };

/** Composio's OUTLOOK_CREATE_DRAFT-style schema: required array of strings. */
const OUTLOOK_SCHEMA = {
  type: "object",
  required: ["subject", "body", "to_recipients"],
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
    to_recipients: { type: "array", items: { type: "string" } },
    cc_recipients: { type: "array", items: { type: "string" } },
    is_html: { type: "boolean" },
  },
};

interface DispatchCapture {
  source: McpSource;
  /** Arguments the fake client received on the last callTool dispatch. */
  lastArgs: () => Record<string, unknown> | undefined;
}

/**
 * Build an McpSource with a scripted inline client that records the
 * `arguments` it is dispatched, and a pre-seeded tool cache so `execute()`
 * resolves the tool's schema without hitting start()/tools().
 */
function buildInlineSource(schema: Record<string, unknown>): DispatchCapture {
  const source = new McpSource(
    "outlook",
    { type: "stdio", spawn: { command: "echo", args: [], env: {} } },
    noopSink,
  );

  let captured: Record<string, unknown> | undefined;
  const fakeClient = {
    callTool: async (req: { name: string; arguments?: Record<string, unknown> }) => {
      captured = req.arguments;
      const result: CallToolResult = { content: [{ type: "text", text: "ok" }], isError: false };
      return result;
    },
    close: async () => {},
  };

  const internals = source as unknown as { client: unknown; cachedTools: unknown };
  internals.client = fakeClient;
  internals.cachedTools = [
    {
      name: "outlook__OUTLOOK_CREATE_DRAFT",
      description: "",
      inputSchema: schema,
      source: "mcpb:outlook",
      // No `execution` → inline (non-task) dispatch path.
    },
  ];

  return { source, lastArgs: () => captured };
}

describe("McpSource.execute — dispatch-boundary coercion", () => {
  it("coerces a JSON-string-encoded array into a real array before dispatch", async () => {
    const { source, lastArgs } = buildInlineSource(OUTLOOK_SCHEMA);

    const result = await source.execute("OUTLOOK_CREATE_DRAFT", {
      subject: "Hi",
      body: "<p>hello</p>",
      to_recipients: '["broker@firm.com"]', // the model's misemission
    });

    expect(result.isError).toBe(false);
    expect(lastArgs()?.to_recipients).toEqual(["broker@firm.com"]);
    expect(Array.isArray(lastArgs()?.to_recipients)).toBe(true);
  });

  it("handles a stringified multi-recipient array", async () => {
    const { source, lastArgs } = buildInlineSource(OUTLOOK_SCHEMA);

    await source.execute("OUTLOOK_CREATE_DRAFT", {
      subject: "Hi",
      body: "x",
      to_recipients: '["a@x.com", "b@y.com"]',
    });

    expect(lastArgs()?.to_recipients).toEqual(["a@x.com", "b@y.com"]);
  });

  it("leaves an already-correct array untouched (idempotent)", async () => {
    const { source, lastArgs } = buildInlineSource(OUTLOOK_SCHEMA);

    await source.execute("OUTLOOK_CREATE_DRAFT", {
      subject: "Hi",
      body: "x",
      to_recipients: ["broker@firm.com"],
    });

    expect(lastArgs()?.to_recipients).toEqual(["broker@firm.com"]);
  });

  it("coerce-then-scrub: a stringified empty array on an OPTIONAL field is dropped", async () => {
    const { source, lastArgs } = buildInlineSource(OUTLOOK_SCHEMA);

    await source.execute("OUTLOOK_CREATE_DRAFT", {
      subject: "Hi",
      body: "x",
      to_recipients: ["broker@firm.com"],
      cc_recipients: "[]", // stringified empty array on an optional field
    });

    // Coercion turns "[]" into [], then scrub strips the empty optional —
    // the field never reaches the wire as a string the vendor would reject.
    expect(lastArgs()?.cc_recipients).toBeUndefined();
    expect(lastArgs()?.to_recipients).toEqual(["broker@firm.com"]);
  });

  it("leaves a stringified scalar (boolean) untouched — scalar coercion is out of scope", async () => {
    const { source, lastArgs } = buildInlineSource(OUTLOOK_SCHEMA);

    await source.execute("OUTLOOK_CREATE_DRAFT", {
      subject: "Hi",
      body: "x",
      to_recipients: ["broker@firm.com"],
      is_html: "true", // model stringifies the boolean; coercion only handles object/array
    });

    // Pinned deliberately: coerce-input recovers structured (object/array)
    // misencodings, not scalars. If a future change starts mangling scalars
    // this fails loudly. (Stringified booleans are a separate, smaller issue.)
    expect(lastArgs()?.is_html).toBe("true");
  });
});

/**
 * Build an McpSource whose tool is task-augmented (execution.taskSupport:
 * "optional"), with a scripted task stream that records the dispatched
 * `arguments`. Proves the task path THROUGH execute() — execute → callToolAsTask
 * → startToolAsTask → callToolStream — also coerces. (The external `/mcp`
 * surface that calls startToolAsTask directly is out of scope here.)
 */
function buildTaskSource(schema: Record<string, unknown>): DispatchCapture {
  const source = new McpSource(
    "outlook",
    { type: "stdio", spawn: { command: "echo", args: [], env: {} } },
    noopSink,
  );

  let captured: Record<string, unknown> | undefined;
  const now = new Date().toISOString();
  const task: Task = {
    taskId: "t1",
    status: "working",
    ttl: 60_000,
    createdAt: now,
    lastUpdatedAt: now,
  };
  async function* taskStream(): AsyncGenerator<unknown, void, void> {
    yield { type: "taskCreated", task };
    yield {
      type: "result",
      result: { content: [{ type: "text", text: "ok" }], isError: false } as CallToolResult,
    };
  }
  const fakeClient = {
    experimental: {
      tasks: {
        callToolStream: (req: { name: string; arguments?: Record<string, unknown> }) => {
          captured = req.arguments;
          return taskStream();
        },
      },
    },
    close: async () => {},
  };

  const internals = source as unknown as { client: unknown; cachedTools: unknown };
  internals.client = fakeClient;
  internals.cachedTools = [
    {
      name: "outlook__OUTLOOK_CREATE_DRAFT",
      description: "",
      inputSchema: schema,
      source: "mcpb:outlook",
      execution: { taskSupport: "optional" }, // → task-augmented dispatch path
    },
  ];

  return { source, lastArgs: () => captured };
}

describe("McpSource.execute — dispatch-boundary coercion (task-augmented path)", () => {
  it("coerces a stringified array before dispatching a task-augmented call", async () => {
    const { source, lastArgs } = buildTaskSource(OUTLOOK_SCHEMA);

    const result = await source.execute("OUTLOOK_CREATE_DRAFT", {
      subject: "Hi",
      body: "x",
      to_recipients: '["broker@firm.com"]',
    });

    expect(result.isError).toBe(false);
    expect(lastArgs()?.to_recipients).toEqual(["broker@firm.com"]);
  });
});
