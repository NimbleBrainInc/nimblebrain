/**
 * `tasks__run` over `/mcp/<wsId>`: a run is an MCP task on the
 * 2026-07-28 leg (the tasks extension). The handle names the run, the run's
 * record exists before the handle is returned, `tasks/get` and `tasks/cancel`
 * read and cancel the run for its owner only, and the handle outlives a
 * restart. A client that does not opt in, and any 2025-era client, gets the
 * inline answer it always got.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { parseDoorTaskId, TASKS_EXTENSION_ID } from "../../src/api/mcp-modern-tasks.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { FIRST_PARTY_GRANT, type VerifiedIdentity } from "../../src/identity/provider.ts";
import { DEV_IDENTITY, DevIdentityProvider } from "../../src/identity/providers/dev.ts";
import { loadOwnerTasks, readRunTicket } from "../../src/platform/tasks/store.ts";
import type { TaskRun } from "../../src/platform/tasks/types.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeIdentity } from "../helpers/identity.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const OTHER_HEADER = "x-tasks-identity";
const OTHER = makeIdentity({ id: "usr_tasks_other", orgRole: "member" });
const OTHER_WORKSPACE_ID = "ws_00c47492e176e75a";
const MODERN_VERSION = "2026-07-28";

/** A prompt word that holds the run's model call until the run is cancelled. */
const HOLD = "HOLD_THIS_RUN";
/** A prompt word that makes the run call `tasks__run` from inside itself. */
const NESTED = "CALL_RUN_FROM_INSIDE";

class TwoIdentityProvider extends DevIdentityProvider {
  override async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    if (req.headers.get(OTHER_HEADER)) return { ...OTHER, grant: FIRST_PARTY_GRANT };
    return super.verifyRequest(req);
  }
}

/** The opening user text of a model call. */
function userText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");
}

/**
 * The echo model, except: a run whose prompt says {@link HOLD} waits until
 * it is aborted; one that says {@link NESTED} first calls
 * `tasks__run`, then answers.
 */
function scriptedModel(): LanguageModelV4 {
  const echo = createEchoModel();
  const nestedCall = (toolName: string) =>
    createEchoModel({
      responses: [
        {
          toolCalls: [
            { toolCallId: "tc_nested", toolName, input: JSON.stringify({ prompt: "spawned" }) },
          ],
        },
      ],
    });
  const pick = (options: LanguageModelV4CallOptions) => {
    if (options.prompt.some((m) => m.role === "tool")) return echo;
    const text = userText(options);
    if (text.includes(NESTED)) return nestedCall("tasks__run");
    return echo;
  };
  const hold = async (options: LanguageModelV4CallOptions) => {
    if (!userText(options).includes(HOLD)) return;
    await new Promise<void>((_resolve, reject) => {
      options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  };
  return {
    ...echo,
    async doGenerate(options) {
      await hold(options);
      return pick(options).doGenerate(options);
    },
    async doStream(options) {
      await hold(options);
      return pick(options).doStream(options);
    },
  };
}

let workDir: string;
let runtime: Runtime;
let handle: ServerHandle;

async function boot(): Promise<void> {
  runtime = await Runtime.start({
    identityProvider: ({ workDir: dir, userStore }) => new TwoIdentityProvider(dir, userStore),
    model: { provider: "custom", adapter: scriptedModel() },
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  await provisionTestWorkspace(runtime, OTHER_WORKSPACE_ID, "Other");
  const ws = await runtime.getWorkspaceStore().get(TEST_WORKSPACE_ID);
  if (!ws?.members.some((m) => m.userId === OTHER.id)) {
    await runtime.getWorkspaceStore().addMember(TEST_WORKSPACE_ID, OTHER.id, "member");
  }
  handle = startServer({ runtime, port: 0 });
}

async function shutdown(): Promise<void> {
  handle.stop(true);
  await runtime.shutdown();
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-mcp-tasks-tasks-"));
  await boot();
});

afterAll(async () => {
  await shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

function mcpUrl(wsId: string = TEST_WORKSPACE_ID): URL {
  return new URL(`http://localhost:${handle.port}/mcp/${wsId}`);
}

/** One 2026-07-28 request on the wire. */
async function modern(
  method: string,
  params: Record<string, unknown>,
  opts: { as?: "owner" | "other"; optIn?: boolean; wsId?: string } = {},
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const name = (params.name ?? params.taskId) as string | undefined;
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
          [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
          [CLIENT_INFO_META_KEY]: { name: "tasks-2026", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: opts.optIn
            ? { extensions: { [TASKS_EXTENSION_ID]: {} } }
            : {},
        },
      },
    }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}");
  return JSON.parse(json);
}

async function startRun(
  args: Record<string, unknown>,
  name: string = "tasks__run",
): Promise<string> {
  const { result, error } = await modern("tools/call", { name, arguments: args }, { optIn: true });
  if (error) throw new Error(`tools/call failed: ${error.message}`);
  expect(result?.resultType).toBe("task");
  return String(result?.taskId);
}

async function taskGet(
  taskId: string,
  opts: { as?: "owner" | "other"; wsId?: string } = {},
): Promise<{ result?: Record<string, unknown>; error?: { code: number } }> {
  return modern("tasks/get", { taskId }, opts);
}

async function untilStatus(taskId: string, status: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const { result } = await taskGet(taskId);
    if (result?.status === status) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} never reached ${status}`);
}

/** The run id a door task id names, after checking it names the tasks source. */
function runIdOf(taskId: string): string {
  const named = parseDoorTaskId(taskId);
  expect(named?.source).toBe("tasks");
  return named?.taskId ?? "";
}

describe("tasks__run on the 2026-07-28 leg", () => {
  it("returns a handle naming the run, whose record exists, and completes with the deliverable", async () => {
    const taskId = await startRun({ prompt: "Write one line.", input: { item: 7 } });
    const runId = runIdOf(taskId);
    expect(runId).toMatch(/^run_/);
    // Written before the handle came back.
    const ticket = readRunTicket(workDir, TEST_WORKSPACE_ID, DEV_IDENTITY.id, runId);
    expect(ticket).not.toBeNull();
    expect(ticket?.run.input).toEqual({ item: 7 });

    const done = await untilStatus(taskId, "completed");
    const result = done.result as CallToolResult;
    const { run } = result.structuredContent as { run: TaskRun };
    expect(run.id).toBe(runId);
    expect(run.status).toBe("success");
    expect(run.input).toEqual({ item: 7 });
    // The echo model's answer is the run's prompt, input block and all.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("<run-input>");
    expect(text).toContain("Write one line.");
  });

  it("answers another identity's poll, and a poll at another workspace's URL, as not found", async () => {
    const taskId = await startRun({ prompt: "Mine." });
    await untilStatus(taskId, "completed");
    expect((await taskGet(taskId, { as: "other" })).error?.code).toBe(-32602);
    expect((await taskGet(taskId, { wsId: OTHER_WORKSPACE_ID })).error?.code).toBe(-32602);
    const cancel = await modern("tasks/cancel", { taskId }, { as: "other" });
    expect(cancel.error?.code).toBe(-32602);
  });

  it("cancels a running run through tasks/cancel", async () => {
    const taskId = await startRun({ prompt: `${HOLD} then answer.` });
    await untilStatus(taskId, "working");
    const ticketStatus = () =>
      readRunTicket(workDir, TEST_WORKSPACE_ID, DEV_IDENTITY.id, runIdOf(taskId))?.run.status;
    for (let i = 0; i < 100 && ticketStatus() !== "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await modern("tasks/cancel", { taskId })).result).toEqual({ resultType: "complete" });
    expect((await untilStatus(taskId, "cancelled")).status).toBe("cancelled");
  });

  it("returns the same handle for a repeated idempotency key", async () => {
    const first = await startRun({ prompt: "Once.", idempotencyKey: "item-1" });
    const again = await startRun({ prompt: "Once.", idempotencyKey: "item-1" });
    expect(runIdOf(again)).toBe(runIdOf(first));
  });

  it("answers inline, as before, when the client does not opt in", async () => {
    const { result } = await modern("tools/call", {
      name: "tasks__run",
      arguments: { prompt: "Inline please." },
    });
    expect(result?.resultType).toBe("complete");
    const content = (result?.content ?? []) as Array<{ text: string }>;
    const body = JSON.parse(content[0]?.text ?? "{}");
    expect(body.run?.status).toBe("success");
    expect(body.run?.id).toMatch(/^run_/);
  });

  it("refuses tasks__run inside a run", async () => {
    const result = await runtime.executeTask({
      prompt: `${NESTED}.`,
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
    });
    const call = result.toolCalls.find((c) => c.name === "tasks__run");
    expect(call?.ok).toBe(false);
    // The refused call created no one-off.
    const prompts = [...loadOwnerTasks(workDir, TEST_WORKSPACE_ID, DEV_IDENTITY.id).values()].map(
      (a) => a.prompt,
    );
    expect(prompts).not.toContain("spawned");
  });

  it("answers a handle after a restart, from the record on disk", async () => {
    const taskId = await startRun({ prompt: "Survive a restart." });
    await untilStatus(taskId, "completed");
    await shutdown();
    await boot();
    const { result } = await taskGet(taskId);
    expect(result?.status).toBe("completed");
  });
});

describe("tasks__run on the 2025-11-25 leg", () => {
  it("answers inline with the run, as before", async () => {
    // The SDK v2 client's default connect is the plain 2025 `initialize` handshake.
    const client = new Client({ name: "tasks-2025", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl()));
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      const result = await client.callTool({
        name: "tasks__run",
        arguments: { prompt: "Legacy inline." },
      });
      expect(result.isError).toBeFalsy();
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.run?.status).toBe("success");
      expect(body.run?.id).toMatch(/^run_/);
    } finally {
      await client.close();
    }
  });
});
