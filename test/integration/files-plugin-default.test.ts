/**
 * The runtime with no `plugins` block binds the built-in files plugin, and
 * every door takes files in and serves them out through it
 * (`contracts/files/CONTRACT.md` §10).
 *
 * - Agents and the door see the public `files__*` tools only; the private ones
 *   are hidden and refused from an agent, the door and the app bridge, and the
 *   source's own client presents `person`, so a forged `host` reaches nothing.
 * - A chat turn's attachments go through the one intake (each body streamed
 *   from a spool to its upload URL): a text file's text comes from the plugin's
 *   `read`, an image is rehydrated into the model call from its download URL,
 *   and each record names the conversation minted for the turn.
 * - The REST upload (the app bridge's too) takes each file in on its own.
 * - The browser download door serves the body under the host's own headers,
 *   and passes a single Range through.
 * - `resources/read` of `files://` at the MCP door, scoped to a source or not.
 * - `files__create` from chat, and from a task run, whose result names the file
 *   from the host's own record of the run's `create`.
 * - The transfer client refuses what the contract refuses, against a live
 *   listener: a redirect, an encoded body, a wrong length, a destination the
 *   binding does not authorise.
 * - The contract's public-only runner passes at `/mcp/<wsId>`.
 * - A deleted workspace takes no files call; its purge removes its files.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { runConformance } from "../../contracts/files/runner/conformance.ts";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import type { ChatStartResponse, UploadResourceResponse } from "../../src/api/schemas/responses.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { createTransferClient, TransferError } from "../../src/files/transfer.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { seedPluginFile } from "../helpers/files-plugin.ts";
import { readJson } from "../helpers/http.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { answer, callTasks, eventually, waitForRun } from "../helpers/tasks-plugin.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const WS = TEST_WORKSPACE_ID;
const PURGED = "ws_0f0f0f0f0f0f0f0f";
const OWNER = DEV_IDENTITY;
const testDir = join(tmpdir(), `nimblebrain-files-default-${Date.now()}`);
const PLUGIN_DATA = join(testDir, "plugin-data", "files");
const PRIVATE_TOOLS = ["begin_upload", "complete_upload", "resolve", "delete_workspace"];
const FORGED_HOST = { "ai.nimblebrain/context": { principal: "host" } };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Each model call's last user message, as the model received it. */
const userMessages: Array<LanguageModelV4CallOptions["prompt"][number]> = [];
/** What a run's tool calls answered, by tool name. */
const toolResults = new Map<string, string>();
/** Each tool call the model made, by id, to repeat one held for guidance. */
const calls = new Map<string, { toolName: string; input: string }>();

function call(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  const one = { toolName, input: JSON.stringify(input) };
  calls.set(toolCallId, one);
  return { type: "tool-call" as const, toolCallId, ...one };
}

function lastUserText(options: LanguageModelV4CallOptions): string {
  const last = options.prompt[options.prompt.length - 1];
  if (last?.role !== "user") return "";
  return last.content.map((p) => ("text" in p ? p.text : "")).join("");
}

const model = createMockModel((options: LanguageModelV4CallOptions) => {
  const last = options.prompt[options.prompt.length - 1];
  if (last?.role === "tool") {
    const again: Array<{ toolName: string; input: string }> = [];
    for (const part of last.content) {
      if (part.type !== "tool-result") continue;
      const out = part.output as { type: string; value?: unknown };
      const text = JSON.stringify(out.value ?? out);
      // A call held for its tool's guidance (the files skill) ran nothing:
      // call it again, as a model would.
      if (text.includes("governed by guidance")) {
        const call = calls.get(part.toolCallId);
        if (call) again.push(call);
      } else toolResults.set(part.toolName, text);
    }
    if (again.length > 0) {
      return {
        content: again.map((call, i) => ({
          type: "tool-call" as const,
          toolCallId: `again-${i}-${call.toolName}`,
          ...call,
        })),
      };
    }
    return { content: [{ type: "text", text: "done" }] };
  }
  if (last) userMessages.push(last);
  const text = lastUserText(options);
  if (text.includes("write a file")) {
    return {
      content: [
        call(`c-${calls.size}`, "files__create", {
          manifest: { filename: "report.md", mimeType: "text/markdown" },
          body: "# the report",
          encoding: "text",
        }),
      ],
    };
  }
  if (text.includes("reach a private tool")) {
    return {
      content: [call(`p-${calls.size}`, "files__resolve", { version: "1.0", uris: ["files://x"] })],
    };
  }
  return { content: [{ type: "text", text: "ok" }] };
});

let runtime: Runtime;
let handle: ServerHandle;
let base: string;

function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

async function mcpClient(wsId = WS): Promise<Client> {
  const client = newMcpClient({ name: "files-default-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${wsId}`)));
  return client;
}

function firstText(result: { content?: unknown }): string {
  return (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
}

function callFiles(tool: string, input: Record<string, unknown>, wsId = WS) {
  const source = runtime.getIdentitySource("files");
  if (!source) throw new Error("no files source");
  return runWithRequestContext({ identity: OWNER, workspaceId: wsId }, () =>
    source.execute(tool, input),
  );
}

/** Files left in the intake's spool: none once a request is done. */
function spooled(): string[] {
  const dir = join(testDir, "tmp", "intake");
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: model,
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  await provisionTestWorkspace(runtime, PURGED, "To purge");
  handle = startServer({ runtime, port: 0 });
  base = `http://localhost:${handle.port}`;
}, 60_000);

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
}, 30_000);

describe("the default binding", () => {
  it("binds the files plugin and serves its public tools only", async () => {
    expect(runtime.isFilesEnabled()).toBe(true);
    const names = (await runtime.listToolsForWorkspace(WS, OWNER.id)).map((t) => t.name);
    for (const tool of ["list", "search", "info", "read", "create", "tag", "move", "delete"]) {
      expect(names).toContain(`files__${tool}`);
    }
    for (const tool of PRIVATE_TOOLS) expect(names).not.toContain(`files__${tool}`);
  });

  it("places the Files screen from the server's own handshake", () => {
    const placements = runtime
      .getPlacementRegistry()
      .forWorkspace(WS)
      .filter((p) => p.serverName === "files");
    expect(placements).toEqual([
      expect.objectContaining({ slot: "sidebar", resourceUri: "ui://files/browser" }),
    ]);
  });
});

describe("a chat turn's attachments", () => {
  it("are taken in, read for text, rehydrated as an image, and name the turn's conversation", async () => {
    const form = new FormData();
    form.append("message", "look at these");
    form.append("files", new File(["alpha beta gamma"], "notes.txt", { type: "text/plain" }));
    form.append("files", new File([PNG], "pic.png", { type: "image/png" }));
    const before = userMessages.length;
    const res = await rest(`/v1/workspaces/${WS}/chat/start`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    const { conversationId } = await readJson<ChatStartResponse>(res);
    expect(spooled()).toEqual([]);

    await eventually(() => userMessages.length > before, 20_000, "the turn's model call");
    const message = userMessages[before];
    if (message?.role !== "user") throw new Error("expected the user message");
    const text = message.content.map((p) => ("text" in p ? p.text : "")).join("");
    expect(text).toContain("--- Attached: notes.txt");
    expect(text).toContain("alpha beta gamma");
    const image = message.content.find((p) => p.type === "file");
    expect(image).toMatchObject({ type: "file", mediaType: "image/png", filename: "pic.png" });
    const bytes = (image as { data: { data: Uint8Array } }).data.data;
    expect([...bytes]).toEqual([...PNG]);

    const listed = answer<{
      files: Array<{ filename: string; conversationId: string; source: string }>;
    }>(await callFiles("list", {}));
    const mine = listed.files.filter((f) => f.filename === "notes.txt" || f.filename === "pic.png");
    expect(mine).toHaveLength(2);
    for (const f of mine) {
      expect(f.conversationId).toBe(conversationId);
      expect(f.source).toBe("chat");
    }
  }, 30_000);

  it("come back with the message on reload, as its files, and the person's text alone", async () => {
    const form = new FormData();
    form.append("message", "summarize this");
    form.append("files", new File(["delta epsilon"], "brief.txt", { type: "text/plain" }));
    const res = await rest(`/v1/workspaces/${WS}/chat/start`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    const { conversationId } = await readJson<ChatStartResponse>(res);
    const source = runtime.getIdentitySource("conversations");
    if (!source) throw new Error("no conversations source");
    const get = () =>
      runWithRequestContext({ identity: OWNER, workspaceId: WS }, () =>
        source.execute("get", { id: conversationId, expand: "full" }),
      );
    type Got = {
      messages: Array<{ role: string; content: string; files?: Array<{ filename: string }> }>;
    };
    let got: Got = { messages: [] };
    await eventually(
      async () => {
        got = answer<Got>(await get());
        return got.messages.some((m) => m.role === "user");
      },
      20_000,
      "the stored user message",
    );
    const user = got.messages.find((m) => m.role === "user");
    expect(user?.content).toBe("summarize this");
    expect(user?.files?.map((f) => f.filename)).toEqual(["brief.txt"]);
    expect(JSON.stringify(got.messages)).not.toContain("--- Attached:");
  }, 30_000);

  it("are refused all together when one breaks a check, and nothing is stored", async () => {
    const count = answer<{ total: number }>(await callFiles("list", {})).total;
    const form = new FormData();
    form.append("message", "x");
    form.append("files", new File(["ok"], "fine.txt", { type: "text/plain" }));
    form.append("files", new File(["<script>"], "bad.js", { type: "text/javascript" }));
    const res = await rest(`/v1/workspaces/${WS}/chat/start`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect(answer<{ total: number }>(await callFiles("list", {})).total).toBe(count);
    expect(spooled()).toEqual([]);
  });

  it("refuses a conversation that is not the caller's in this workspace", async () => {
    const form = new FormData();
    form.append("message", "x");
    form.append("conversationId", "conv_0000000000000000");
    form.append("files", new File(["ok"], "fine.txt", { type: "text/plain" }));
    const res = await rest(`/v1/workspaces/${WS}/chat/start`, { method: "POST", body: form });
    expect(res.status).toBe(404);
  });
});

describe("the REST and app-bridge upload", () => {
  it("takes each file in on its own and answers the records", async () => {
    const form = new FormData();
    form.append("files", new File(["kept"], "kept.md", { type: "text/markdown" }));
    form.append("files", new File(["no"], "refused.exe", { type: "application/x-msdownload" }));
    form.append("tags", JSON.stringify(["upload"]));
    const res = await rest(`/v1/workspaces/${WS}/resources`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = await readJson<UploadResourceResponse>(res);
    expect(body.files.map((f) => [f.filename, f.source, f.tags])).toEqual([
      ["kept.md", "app", ["upload"]],
    ]);
    expect(body.errors?.[0]).toContain("refused.exe");
    expect(JSON.stringify(body)).not.toContain("/t/");
  });
});

describe("the browser download door", () => {
  it("serves the body under the host's own headers, and a single Range", async () => {
    const file = await seedPluginFile(runtime, WS, OWNER.id, {
      filename: 'a "quoted"\r\nname.html',
      mimeType: "text/html",
      body: "0123456789",
    });
    const whole = await rest(`/v1/workspaces/${WS}/files/${file.id}`);
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe("0123456789");
    expect(whole.headers.get("content-type")).toBe("text/html");
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    expect(whole.headers.get("content-security-policy")).toStartWith("sandbox;");
    expect(whole.headers.get("content-length")).toBe("10");
    const disposition = whole.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(`filename="a _quoted___name.html"`);
    expect(disposition).toContain("filename*=UTF-8''");

    const part = await rest(`/v1/workspaces/${WS}/files/${file.id}`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");

    const past = await rest(`/v1/workspaces/${WS}/files/${file.id}`, {
      headers: { Range: "bytes=50-" },
    });
    expect(past.status).toBe(416);
  });

  it("answers not found for another workspace, and for an id that names nothing", async () => {
    const file = await seedPluginFile(runtime, WS, OWNER.id, { filename: "x.txt", body: "x" });
    expect((await rest(`/v1/workspaces/${PURGED}/files/${file.id}`)).status).toBe(404);
    expect((await rest(`/v1/workspaces/${WS}/files/fl_nothing`)).status).toBe(404);
  });
});

describe("resources/read of files:// at the MCP door", () => {
  it("answers the body, unscoped and scoped to the files app as the bridge reads", async () => {
    const file = await seedPluginFile(runtime, WS, OWNER.id, { filename: "r.txt", body: "door" });
    const client = await mcpClient();
    try {
      const plain = await client.readResource({ uri: `files://${file.id}` });
      expect((plain.contents[0] as { text?: string }).text).toBe("door");
      const scoped = await client.readResource({
        uri: `files://${file.id}`,
        _meta: { [RESOURCE_SOURCE_META_KEY]: "files" },
      });
      expect((scoped.contents[0] as { text?: string }).text).toBe("door");
      const listed = (await client.listResources()).resources.map((r) => r.uri);
      expect(listed).toContain(`files://${file.id}`);
    } finally {
      await client.close();
    }
    const elsewhere = await mcpClient(PURGED);
    try {
      await expect(elsewhere.readResource({ uri: `files://${file.id}` })).rejects.toThrow(
        /not found/i,
      );
    } finally {
      await elsewhere.close();
    }
  });
});

/** A `resources/read` of a file as the chat's resource-link view sends it. */
async function readThroughHost(
  uri: string,
): Promise<{ mimeType?: string; text?: string; blob?: string }> {
  const res = await rest(`/v1/workspaces/${WS}/resources/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server: "files", uri }),
  });
  expect(res.status).toBe(200);
  const body = await readJson<{
    contents: Array<{ mimeType?: string; text?: string; blob?: string }>;
  }>(res);
  return body.contents[0] ?? {};
}

describe("files__info gives the person a file to download", () => {
  const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
  for (const [filename, mimeType, body] of [
    ["red.png", "image/png", PNG],
    ["paper.pdf", "application/pdf", PDF],
    ["notes.txt", "text/plain", new TextEncoder().encode("plain words")],
  ] as const) {
    it(`answers a resource_link to ${mimeType}, whose bytes the host serves`, async () => {
      const file = await seedPluginFile(runtime, WS, OWNER.id, { filename, mimeType, body });
      const result = await callFiles("info", { id: file.id });
      const links = result.content.filter((b) => b.type === "resource_link");
      expect(links).toEqual([
        {
          type: "resource_link",
          uri: `files://${file.id}`,
          name: filename,
          mimeType,
          size: body.byteLength,
        },
      ]);
      const read = await readThroughHost(`files://${file.id}`);
      expect(read.mimeType).toBe(mimeType);
      const bytes =
        read.blob !== undefined
          ? Buffer.from(read.blob, "base64")
          : Buffer.from(read.text ?? "", "utf-8");
      expect([...bytes]).toEqual([...body]);
      const download = await rest(`/v1/workspaces/${WS}/files/${file.id}`);
      expect(download.status).toBe(200);
      expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([...body]);
    });
  }
});

describe("files__create", () => {
  it("from chat stores the file as the agent's", async () => {
    await runtime.chat({ identity: OWNER, workspaceId: WS, message: "please write a file" });
    // The tool result's value is the text the tool answered, itself JSON.
    const value = JSON.parse(toolResults.get("files__create") ?? '""') as string;
    const created = JSON.parse(value || "{}") as { id?: string };
    expect(created.id).toBeString();
    const info = answer<{ source: string }>(await callFiles("info", { id: created.id }));
    expect(info.source).toBe("agent");
  }, 30_000);

  it("from chat names the file in a resource_link the chat reads through the host", async () => {
    const chat = await runtime.chat({
      identity: OWNER,
      workspaceId: WS,
      message: "please write a file",
    });
    const store = await runtime.resolveConversationStore(WS, chat.conversationId, OWNER.id);
    const events = await store?.readEvents(chat.conversationId);
    const done = events?.find(
      (e) => e.type === "tool.done" && (e as { name?: string }).name === "files__create",
    ) as { ok?: boolean; resourceLinks?: Array<{ uri: string; name?: string; mimeType?: string }> };
    expect(done?.ok).toBe(true);
    expect(done.resourceLinks).toEqual([
      { uri: expect.stringMatching(/^files:\/\//), name: "report.md", mimeType: "text/markdown" },
    ]);
    const read = await readThroughHost(done.resourceLinks?.[0]?.uri ?? "");
    expect(read.text).toBe("# the report");
  }, 30_000);

  it("from a task run is the run's file, which the run's result names", async () => {
    answer(
      await callTasks(runtime, OWNER, WS, "create", {
        manifest: { name: "Writer", allowedTools: ["files__*"] },
        body: "write a file",
      }),
    );
    const asked = answer<{ runId: string }>(
      await callTasks(runtime, OWNER, WS, "run", { taskId: "writer" }),
    );
    const ended = await waitForRun(runtime, OWNER, WS, asked.runId, 30_000);
    expect(ended.run.execution).toBe("completed");
    const files = (ended.result?.outputFiles ?? []) as Array<{ uri: string; name?: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("report.md");
    const id = files[0]?.uri.replace("files://", "") ?? "";
    const info = answer<{ runId: string | null }>(await callFiles("info", { id }));
    expect(info.runId).toBeString();
  }, 40_000);
});

describe("private tools and a forged host principal reach nothing", () => {
  it("an agent cannot reach a private tool", async () => {
    await runtime.chat({ identity: OWNER, workspaceId: WS, message: "reach a private tool" });
    expect(toolResults.get("files__resolve")).toMatch(/not available|not found|unknown/i);
  }, 30_000);

  it("the door lists none and refuses each, and the bridge's scoped call too", async () => {
    const client = await mcpClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const tool of PRIVATE_TOOLS) expect(names).not.toContain(`files__${tool}`);
      for (const meta of [FORGED_HOST, { ...FORGED_HOST, [RESOURCE_SOURCE_META_KEY]: "files" }]) {
        const refused = await client
          .callTool({
            name: "files__resolve",
            arguments: { version: "1.0", uris: [] },
            _meta: meta,
          })
          .then(
            (r) => firstText(r),
            (e: Error) => e.message,
          );
        expect(refused).toMatch(/not (listed|available)/);
      }
    } finally {
      await client.close();
    }
  });

  it("the source's own client presents person: every private tool refuses forbidden", async () => {
    const source = runtime.getIdentitySource("files");
    expect(source).toBeInstanceOf(McpSource);
    const client = (source as McpSource).getClient();
    for (const name of PRIVATE_TOOLS) {
      const result = await runWithRequestContext({ identity: OWNER, workspaceId: WS }, () =>
        client?.callTool({ name, arguments: {}, _meta: FORGED_HOST }),
      );
      expect(result?.isError).toBe(true);
      expect(JSON.parse(firstText(result ?? {})).code).toBe("forbidden");
    }
  });
});

describe("the transfer client against a live listener", () => {
  let listener: ReturnType<typeof Bun.serve>;
  let origin: string;
  beforeAll(() => {
    listener = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/redirect") {
          return new Response(null, { status: 302, headers: { location: `${origin}/ok` } });
        }
        if (path === "/gzip") {
          return new Response("abc", { headers: { "content-encoding": "gzip" } });
        }
        if (path === "/long") return new Response("abcdef");
        return new Response("abc");
      },
    });
    origin = `http://127.0.0.1:${listener.port}`;
  });
  afterAll(() => listener?.stop(true));

  const stdio = () =>
    createTransferClient({ destinations: { serverOrigin: null, listed: [], loopback: true } });

  it("fetches the binding's loopback listener", async () => {
    const got = await stdio().download(`${origin}/ok`, { size: 3 });
    expect(await new Response(got.body).text()).toBe("abc");
  });

  it("refuses a redirect, an encoded body and a wrong length", async () => {
    for (const path of ["/redirect", "/gzip", "/long"]) {
      await expect(stdio().download(`${origin}${path}`, { size: 3 })).rejects.toBeInstanceOf(
        TransferError,
      );
    }
  });

  it("a remote binding never reaches loopback, listed or not", async () => {
    const remote = createTransferClient({
      destinations: {
        serverOrigin: "https://files.example.com",
        listed: [origin],
        loopback: false,
      },
    });
    await expect(remote.download(`${origin}/ok`, { size: 3 })).rejects.toBeInstanceOf(
      TransferError,
    );
    await expect(remote.download("http://localhost:1/ok", { size: 3 })).rejects.toBeInstanceOf(
      TransferError,
    );
  });
});

describe("the door", () => {
  it("takes a create whose 4 MiB body is past the old 1 MiB request bound", async () => {
    const client = await mcpClient();
    try {
      const bytes = new Uint8Array(4 * 1_048_576).fill(7);
      const made = await client.callTool({
        name: "files__create",
        arguments: {
          manifest: { filename: "big.bin", mimeType: "application/octet-stream" },
          body: Buffer.from(bytes).toString("base64"),
        },
      });
      expect(made.isError).toBeFalsy();
      const id = (made.structuredContent as { id: string }).id;
      const served = await rest(`/v1/workspaces/${WS}/files/${id}`);
      expect((await served.arrayBuffer()).byteLength).toBe(bytes.byteLength);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("the contract's public-only runner passes at /mcp/<wsId>", async () => {
    const results = await runConformance({
      server: `${base}/mcp/${WS}`,
      publicOnly: true,
      carriage: "none",
      toolPrefix: "files__",
    });
    const failed = results.filter((r) => r.status === "fail").map((r) => `${r.name}: ${r.detail}`);
    expect(failed).toEqual([]);
    expect(results.find((r) => r.name === "no private tool is listed")?.status).toBe("pass");
  }, 90_000);
});

describe("workspace delete", () => {
  it("a deleted workspace takes no files call, and its purge removes its files", async () => {
    await seedPluginFile(runtime, PURGED, OWNER.id, { filename: "gone.txt", body: "bye" });
    expect(existsSync(join(PLUGIN_DATA, "workspaces", PURGED))).toBe(true);
    const deleted = await runWithRequestContext({ identity: OWNER, workspaceId: PURGED }, () =>
      runtime.deleteWorkspace(PURGED),
    );
    expect(deleted.deleted).toBe(true);
    const refused = await callFiles("list", {}, PURGED);
    expect(refused.isError).toBe(true);
    expect(firstText(refused)).toContain("workspace_deleted");
    await expect(
      runtime.getFiles()?.resolve({ workspaceId: PURGED, ownerId: OWNER.id }, ["files://x"]),
    ).rejects.toThrow(/workspace_deleted/);

    const purge = await runtime.purgeWorkspace(PURGED);
    expect(purge).toEqual({ purged: true, connectors: [] });
    expect(existsSync(join(PLUGIN_DATA, "workspaces", PURGED))).toBe(false);
  }, 30_000);
});
