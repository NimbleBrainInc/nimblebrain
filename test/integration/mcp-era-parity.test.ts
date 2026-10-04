/**
 * `/mcp/<wsId>` serves both protocol eras, and they are equivalent but for task
 * augmentation: a client on `2026-07-28` can do everything a client on
 * `2025-11-25` can. This suite is the guard on that rule. One set of scenarios
 * runs against each leg through a driver per era, and every assertion is
 * shared, so a change that lets the legs drift fails here.
 *
 * - 2025 leg: the SDK v1 client, sessionful. It serves no task augmentation
 *   (ADR-0046): no `tasks` capability, a `params.task` ignored, no `tasks/*`.
 * - 2026 leg: the SDK v2 client for what it speaks, and the tasks extension
 *   (SEP-2663) on the wire for what it does not (typescript-sdk#2189): opt-in
 *   per request, a flat task, `tasks/get` inlining the outcome.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  EmptyResultSchema,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { TASKS_EXTENSION_ID } from "../../src/api/mcp-modern-tasks.ts";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { FIRST_PARTY_GRANT, type VerifiedIdentity } from "../../src/identity/provider.ts";
import { DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineInProcessApp } from "../../src/tools/in-process-app.ts";
import {
  TaskAlreadyTerminalError,
  TaskNotFoundError,
  type TaskOwnerContext,
  type Tool,
  type ToolSource,
} from "../../src/tools/types.ts";
import { buildMcpRequest, readMcpAnswer } from "../../web/src/mcp-bridge-client.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeIdentity } from "../helpers/identity.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

// ── Fixture: a task-aware source, a resource source, two identities ─────

const SOURCE = "jobs";
const APP_URI = "ui://parity/app";
const APP_HTML = "<!doctype html><title>parity</title>";
/** The header that makes a request the second identity's. */
const OTHER_HEADER = "x-parity-identity";
const OTHER = makeIdentity({ id: "usr_parity_other", orgRole: "member" });

/** The dev provider, except a request carrying {@link OTHER_HEADER} is {@link OTHER}. */
class TwoIdentityProvider extends DevIdentityProvider {
  override async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    if (req.headers.get(OTHER_HEADER)) return { ...OTHER, grant: FIRST_PARTY_GRANT };
    return super.verifyRequest(req);
  }
}

interface HeldTask {
  owner: TaskOwnerContext;
  task: Task;
  settle: (result: CallToolResult) => void;
  result: Promise<CallToolResult>;
}

/**
 * The `McpSource` task surface over in-memory tasks. `echo` runs inline;
 * `research` runs as a task that stays `working` until the test settles it.
 */
class JobsSource implements ToolSource {
  readonly name = SOURCE;
  private readonly held = new Map<string, HeldTask>();
  private readonly fail = new Map<string, (err: Error) => void>();
  /** How many tasks have been started. */
  get started(): number {
    return this.held.size;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async tools(): Promise<Tool[]> {
    return [
      {
        name: `${SOURCE}__echo`,
        description: "Echoes",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        source: `mcp:${SOURCE}`,
      },
      {
        name: `${SOURCE}__research`,
        description: "Researches, as a task",
        inputSchema: { type: "object", properties: {} },
        source: `mcp:${SOURCE}`,
        execution: { taskSupport: "optional" },
      },
      {
        name: `${SOURCE}__batch`,
        description: "Runs only as a task",
        inputSchema: { type: "object", properties: {} },
        source: `mcp:${SOURCE}`,
        execution: { taskSupport: "required" },
      },
    ];
  }

  async execute(tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    return { content: textContent(`${tool}:${String(input.text ?? "")}`), isError: false };
  }

  /** Complete every task still working with `result`. */
  settleWorking(result: CallToolResult): void {
    for (const held of this.held.values()) {
      if (held.task.status === "working") held.settle(result);
    }
  }

  /** End every task still working with no result, as a connector that errored would. */
  failWorking(message: string): void {
    for (const [taskId, held] of this.held) {
      if (held.task.status !== "working") continue;
      held.task = { ...held.task, status: "failed", lastUpdatedAt: new Date().toISOString() };
      this.fail.get(taskId)?.(new Error(message));
    }
  }

  async startToolAsTask(
    _tool: string,
    _args: Record<string, unknown>,
    opts: { ownerContext: TaskOwnerContext; ttlMs?: number },
  ): Promise<{ task: Task }> {
    const now = new Date().toISOString();
    const task: Task = {
      taskId: `job-${crypto.randomUUID()}`,
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttl: opts.ttlMs ?? 60_000,
      pollInterval: 10,
    };
    let settle!: (result: CallToolResult) => void;
    let fail!: (err: Error) => void;
    const result = new Promise<CallToolResult>((res, rej) => {
      settle = res;
      fail = rej;
    });
    const held: HeldTask = {
      owner: { ...opts.ownerContext },
      task,
      result,
      settle: (r) => {
        const status = r.isError ? "failed" : "completed";
        held.task = { ...held.task, status, lastUpdatedAt: new Date().toISOString() };
        settle(r);
      },
    };
    held.result.catch(() => {});
    this.held.set(task.taskId, held);
    this.fail.set(task.taskId, fail);
    return { task };
  }

  private owned(taskId: string, owner: TaskOwnerContext): HeldTask {
    const held = this.held.get(taskId);
    const o = held?.owner;
    if (
      !held ||
      !o ||
      o.workspaceId !== owner.workspaceId ||
      o.identityId !== owner.identityId ||
      o.originApp !== owner.originApp
    ) {
      throw new TaskNotFoundError(taskId);
    }
    return held;
  }

  async getTaskStatus(taskId: string, opts: { ownerContext: TaskOwnerContext }): Promise<Task> {
    return this.owned(taskId, opts.ownerContext).task;
  }

  async awaitToolTaskResult(
    taskId: string,
    opts: { ownerContext: TaskOwnerContext },
  ): Promise<CallToolResult> {
    return this.owned(taskId, opts.ownerContext).result;
  }

  async cancelTask(taskId: string, opts: { ownerContext: TaskOwnerContext }): Promise<Task> {
    const held = this.owned(taskId, opts.ownerContext);
    if (held.task.status !== "working") {
      throw new TaskAlreadyTerminalError(taskId, held.task.status);
    }
    held.task = { ...held.task, status: "cancelled", lastUpdatedAt: new Date().toISOString() };
    this.fail.get(taskId)?.(new Error(`task ${taskId} cancelled`));
    return held.task;
  }
}

let runtime: Runtime;
let handle: ServerHandle;
let workDir: string;
let jobs: JobsSource;

/** A second workspace the dev identity belongs to, with a source of the same name. */
const OTHER_WORKSPACE_ID = "ws_005c47492e176e75";

function mcpUrl(wsId: string = TEST_WORKSPACE_ID): URL {
  return new URL(`http://localhost:${handle.port}/mcp/${wsId}`);
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-mcp-era-parity-"));
  runtime = await Runtime.start({
    identityProvider: ({ workDir: dir, userStore }) => new TwoIdentityProvider(dir, userStore),
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, OTHER.id, "member");
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
  jobs = new JobsSource();
  registry.addSource(jobs);
  const app = defineInProcessApp(
    { name: "parity", version: "1.0.0", tools: [], resources: new Map([[APP_URI, APP_HTML]]) },
    new NoopEventSink(),
  );
  await app.start();
  registry.addSource(app);
  await provisionTestWorkspace(runtime, OTHER_WORKSPACE_ID, "Other");
  runtime.getRegistryForWorkspace(OTHER_WORKSPACE_ID).addSource(new JobsSource());
  handle = startServer({ runtime, port: 0 });
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

// ── One driver per era ─────────────────────────────────────────────────

/** What a scenario does at the door, in each era's own vocabulary. */
interface EraDriver {
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readResource(uri: string): Promise<string | undefined>;
  close(): Promise<void>;
}

/** A JSON-RPC error's code, from whichever SDK or wire raised it. */
async function errorCode(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: number }).code;
  }
}

/** A 2025-era client of the door, as the owner or as {@link OTHER}. */
async function legacyClient(as: "owner" | "other" = "owner"): Promise<LegacyClient> {
  const client = new LegacyClient({ name: "parity-2025", version: "1.0.0" });
  const headers: Record<string, string> = as === "other" ? { [OTHER_HEADER]: "1" } : {};
  await client.connect(new LegacyTransport(mcpUrl(), { requestInit: { headers } }));
  return client;
}

async function legacyDriver(): Promise<EraDriver> {
  const owner = await legacyClient();
  return {
    listTools: async () => (await owner.listTools()).tools.map((t) => t.name),
    callTool: async (name, args) =>
      (await owner.callTool({ name, arguments: args }, CallToolResultSchema)) as CallToolResult,
    readResource: async (uri) => {
      const read = await owner.readResource({ uri });
      const first = read.contents[0];
      return first && "text" in first ? first.text : undefined;
    },
    close: () => owner.close(),
  };
}

const MODERN_VERSION = "2026-07-28";

/**
 * One 2026-07-28 request on the wire, with the envelope and the standard
 * headers the SDK's transport would derive from it.
 */
async function modernPost(
  method: string,
  params: Record<string, unknown>,
  opts: { as?: "owner" | "other"; optIn?: boolean; name?: string; wsId?: string } = {},
): Promise<{
  status: number;
  body: { result?: Record<string, unknown>; error?: { code: number } };
}> {
  const name = opts.name ?? ((params.name ?? params.taskId ?? params.uri) as string | undefined);
  const res = await fetch(mcpUrl(opts.wsId), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN_VERSION,
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": name } : {}),
      ...(opts.as === "other" ? { [OTHER_HEADER]: "1" } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          ...(params._meta as Record<string, unknown> | undefined),
          [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
          [CLIENT_INFO_META_KEY]: { name: "parity-2026", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: opts.optIn
            ? { extensions: { [TASKS_EXTENSION_ID]: {} } }
            : {},
        },
      },
    }),
  });
  const text = await res.text();
  // A JSON body, or one SSE `data:` event carrying it.
  const json = text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}");
  return { status: res.status, body: JSON.parse(json) };
}

/** The result of a 2026 request, or its JSON-RPC error thrown as `{ code }`. */
async function modernResult(
  ...args: Parameters<typeof modernPost>
): Promise<Record<string, unknown>> {
  const { body } = await modernPost(...args);
  if (body.error) throw body.error;
  return body.result ?? {};
}

async function modernDriver(): Promise<EraDriver> {
  const client = new ModernClient(
    { name: "parity-2026", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(new ModernTransport(mcpUrl()));
  expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_VERSION);
  return {
    listTools: async () => (await client.listTools()).tools.map((t) => t.name),
    callTool: async (name, args) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    readResource: async (uri) => {
      const read = await client.readResource({ uri });
      const first = read.contents[0];
      return first && "text" in first ? first.text : undefined;
    },
    close: () => client.close(),
  };
}

/** Start `name` as a 2026 task; the task's id. */
async function startModernTask(name: string): Promise<string> {
  const created = await modernResult("tools/call", { name, arguments: {} }, { optIn: true });
  expect(created.resultType).toBe("task");
  return String(created.taskId);
}

async function modernStatus(taskId: string, as: "owner" | "other" = "owner") {
  return (await modernResult("tasks/get", { taskId }, { as })).status as Task["status"];
}

// ── The scenarios, once per era ──────────────────────────────────────

describe.each([
  { era: "2025-11-25", driver: legacyDriver },
  { era: "2026-07-28", driver: modernDriver },
])("/mcp/<wsId> on $era", ({ driver }) => {
  let d: EraDriver;

  beforeAll(async () => {
    d = await driver();
  });

  afterAll(async () => {
    await d.close();
  });

  it("lists the workspace's tools by their bare names", async () => {
    expect(await d.listTools()).toEqual(
      expect.arrayContaining([`${SOURCE}__echo`, `${SOURCE}__research`]),
    );
  });

  it("calls a tool", async () => {
    const result = await d.callTool(`${SOURCE}__echo`, { text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(result.isError).toBe(false);
  });

  it("refuses an agent's call to an app-only tool", async () => {
    // `nb__workspace_info` declares `ui.visibility: ["app"]`; this call names
    // no source, so it is an agent's.
    await expect(d.callTool("nb__workspace_info", {})).rejects.toThrow(/not callable by an agent/);
  });

  it("reads a resource", async () => {
    expect(await d.readResource(APP_URI)).toBe(APP_HTML);
  });
});

describe("/mcp/<wsId> on 2025-11-25 serves no task augmentation", () => {
  let client: LegacyClient;

  beforeAll(async () => {
    client = await legacyClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it("declares no tasks capability", () => {
    expect(client.getServerCapabilities()?.tasks).toBeUndefined();
  });

  it("runs a call carrying params.task to completion, ignoring the task", async () => {
    const before = jobs.started;
    const result = await client.request(
      {
        method: "tools/call",
        params: { name: `${SOURCE}__research`, arguments: {}, task: { ttl: 60_000 } },
      },
      CallToolResultSchema,
    );
    expect(result.content).toEqual([{ type: "text", text: "research:" }]);
    expect(jobs.started).toBe(before);
  });

  it("runs a task-only tool to completion", async () => {
    const before = jobs.started;
    const result = await client.callTool({ name: `${SOURCE}__batch`, arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "batch:" }]);
    expect(jobs.started).toBe(before);
  });

  for (const method of ["tasks/get", "tasks/result", "tasks/cancel", "tasks/list"]) {
    it(`answers ${method} as method not found`, async () => {
      const params = method === "tasks/list" ? {} : { taskId: "job-any" };
      expect(await errorCode(client.request({ method, params }, EmptyResultSchema))).toBe(-32601);
    });
  }
});

describe("/mcp/<wsId> task lifecycle on 2026-07-28", () => {
  it("advertises the tasks extension before any call", async () => {
    const client = new ModernClient(
      { name: "parity-2026", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new ModernTransport(mcpUrl()));
    try {
      expect(client.getServerCapabilities()?.extensions?.[TASKS_EXTENSION_ID]).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("runs a task to completion", async () => {
    const taskId = await startModernTask(`${SOURCE}__research`);
    expect(await modernStatus(taskId)).toBe("working");
    jobs.settleWorking({ content: [{ type: "text", text: "researched" }] });
    const got = await modernResult("tasks/get", { taskId });
    expect(got.status).toBe("completed");
    expect(got.result).toEqual({ content: [{ type: "text", text: "researched" }] });
  });

  it("cancels a task", async () => {
    const taskId = await startModernTask(`${SOURCE}__research`);
    expect(await modernResult("tasks/cancel", { taskId })).toEqual({ resultType: "complete" });
    expect(await modernStatus(taskId)).toBe("cancelled");
  });

  it("refuses another identity's task as not found", async () => {
    const taskId = await startModernTask(`${SOURCE}__research`);
    try {
      expect(await errorCode(modernStatus(taskId, "other"))).toBe(-32602);
      expect(await errorCode(modernStatus(`${taskId}-unknown`))).toBe(-32602);
    } finally {
      await modernResult("tasks/cancel", { taskId });
    }
  });
});

// ── What only the 2026 wire can get wrong ─────────────────────────────

describe("/mcp/<wsId> tasks on 2026-07-28", () => {
  it("answers outright a call that did not opt in to the tasks extension", async () => {
    const result = await modernResult("tools/call", { name: `${SOURCE}__research`, arguments: {} });
    expect(result.resultType).toBe("complete");
  });

  it("refuses a call to a task-only tool that did not opt in, naming the extension", async () => {
    const { body } = await modernPost("tools/call", { name: `${SOURCE}__batch`, arguments: {} });
    expect(body.error?.code).toBe(-32021);
    expect((body.error as { data?: unknown } | undefined)?.data).toEqual({
      requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
    });
  });

  it("answers outright an opted-in call to a tool that cannot run as a task", async () => {
    const result = await modernResult(
      "tools/call",
      { name: `${SOURCE}__echo`, arguments: { text: "quick" } },
      { optIn: true },
    );
    expect(result.resultType).toBe("complete");
    expect(result.content).toEqual([{ type: "text", text: "echo:quick" }]);
  });

  it("answers a poll on its own request, with no session", async () => {
    const created = await modernResult(
      "tools/call",
      { name: `${SOURCE}__research`, arguments: {} },
      { optIn: true },
    );
    const taskId = String(created.taskId);
    // Every request here is independent: nothing carries a session id.
    expect((await modernResult("tasks/get", { taskId })).status).toBe("working");
    expect(await modernResult("tasks/cancel", { taskId })).toEqual({ resultType: "complete" });
    // A second cancel of a terminal task is still an acknowledgement.
    expect(await modernResult("tasks/cancel", { taskId })).toEqual({ resultType: "complete" });
  });

  it("refuses a poll scoped to a source that did not run the task", async () => {
    const created = await modernResult(
      "tools/call",
      { name: `${SOURCE}__research`, arguments: {} },
      { optIn: true },
    );
    const taskId = String(created.taskId);
    try {
      const scoped = modernResult("tasks/get", {
        taskId,
        _meta: { [RESOURCE_SOURCE_META_KEY]: "parity" },
      });
      expect(await errorCode(scoped)).toBe(-32602);
    } finally {
      await modernResult("tasks/cancel", { taskId });
    }
  });

  it("does not serve tasks/update: a task that asks for input is not supported", async () => {
    const { body } = await modernPost("tasks/update", { taskId: "t", inputResponses: {} });
    expect(body.error?.code).toBe(-32601);
  });

  it("refuses a poll at another workspace's URL, where the same source name runs", async () => {
    const created = await modernResult(
      "tools/call",
      { name: `${SOURCE}__research`, arguments: {} },
      { optIn: true },
    );
    const taskId = String(created.taskId);
    try {
      const elsewhere = modernResult("tasks/get", { taskId }, { wsId: OTHER_WORKSPACE_ID });
      expect(await errorCode(elsewhere)).toBe(-32602);
    } finally {
      await modernResult("tasks/cancel", { taskId });
    }
  });

  it("inlines a tool's isError result as completed: the tool answered", async () => {
    const created = await modernResult(
      "tools/call",
      { name: `${SOURCE}__research`, arguments: {} },
      { optIn: true },
    );
    const error: CallToolResult = {
      content: [{ type: "text", text: "no such topic" }],
      isError: true,
    };
    jobs.settleWorking(error);
    const got = await modernResult("tasks/get", { taskId: String(created.taskId) });
    expect(got.status).toBe("completed");
    expect(got.result).toEqual(error);
  });

  it("inlines a JSON-RPC error for a task that ended with no result", async () => {
    const created = await modernResult(
      "tools/call",
      { name: `${SOURCE}__research`, arguments: {} },
      { optIn: true },
    );
    jobs.failWorking("connector went away");
    const got = await modernResult("tasks/get", { taskId: String(created.taskId) });
    expect(got.status).toBe("failed");
    expect(got.result).toBeUndefined();
    expect(got.error).toEqual({ code: -32603, message: "connector went away" });
  });

  it("refuses a poll whose Mcp-Name header does not name the task", async () => {
    const { status, body } = await modernPost("tasks/get", { taskId: "t" }, { name: "other" });
    expect(status).toBe(400);
    expect(body.error?.code).toBe(-32020);
  });
});

// ── The app bridge's requests, as the web shell builds them ──────────────

describe("/mcp/<wsId> answers the app bridge on 2026-07-28", () => {
  /** One request exactly as the web shell's bridge sends it, scoped to `app`. */
  async function bridgeSend(
    method: string,
    params: Record<string, unknown>,
    opts: { app?: string; tasks?: boolean } = {},
  ) {
    const { headers, body } = buildMcpRequest(
      "bridge-1",
      method,
      { ...params, _meta: { [RESOURCE_SOURCE_META_KEY]: opts.app ?? SOURCE } },
      { tasks: opts.tasks },
    );
    return readMcpAnswer(await fetch(mcpUrl(), { method: "POST", headers, body }));
  }

  async function bridgeResult(...args: Parameters<typeof bridgeSend>) {
    const answer = await bridgeSend(...args);
    if ("error" in answer) throw answer.error;
    return answer.result;
  }

  it("runs an opted-in call as a task, and answers its polls with the outcome inline", async () => {
    const created = await bridgeResult(
      "tools/call",
      { name: `${SOURCE}__research`, arguments: {} },
      { tasks: true },
    );
    expect(created.resultType).toBe("task");
    const taskId = String(created.taskId);
    expect((await bridgeResult("tasks/get", { taskId })).status).toBe("working");

    const done: CallToolResult = { content: [{ type: "text", text: "report" }] };
    jobs.settleWorking(done);
    const got = await bridgeResult("tasks/get", { taskId });
    expect(got.status).toBe("completed");
    expect(got.result).toEqual(done);
  });

  it("answers a call that did not opt in outright", async () => {
    const result = await bridgeResult("tools/call", {
      name: `${SOURCE}__echo`,
      arguments: { text: "hi" },
    });
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });

  it("cancels a task, and refuses a poll scoped to another app as not found", async () => {
    const created = await bridgeResult(
      "tools/call",
      { name: `${SOURCE}__research`, arguments: {} },
      { tasks: true },
    );
    const taskId = String(created.taskId);
    const elsewhere = await bridgeSend("tasks/get", { taskId }, { app: "parity" });
    expect("error" in elsewhere && elsewhere.error.code).toBe(-32602);
    expect(await bridgeResult("tasks/cancel", { taskId })).toEqual({ resultType: "complete" });
    expect((await bridgeResult("tasks/get", { taskId })).status).toBe("cancelled");
  });

  it("reads and lists the app's own resources", async () => {
    const read = await bridgeResult("resources/read", { uri: APP_URI }, { app: "parity" });
    expect((read.contents as Array<{ text?: string }>)[0]?.text).toBe(APP_HTML);
    const listed = await bridgeResult("resources/list", {}, { app: "parity" });
    expect(Array.isArray(listed.resources)).toBe(true);
    const templates = await bridgeResult("resources/templates/list", {}, { app: "parity" });
    expect(Array.isArray(templates.resourceTemplates)).toBe(true);
  });

  it("refuses a read of another app's resource as not found", async () => {
    const read = await bridgeSend("resources/read", { uri: APP_URI }, { app: SOURCE });
    expect("error" in read).toBe(true);
  });
});
