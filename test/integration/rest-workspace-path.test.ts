/**
 * REST addresses a workspace by URL: every workspace-scoped route lives under
 * `/v1/workspaces/<wsId>/`, and an identity-scoped route names no workspace.
 *
 * Mostly negative cases: the retired paths are gone, a workspace the caller
 * cannot reach gets one answer on every router, and an `X-Workspace-Id`
 * header changes nothing anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApiErrorBody,
  BootstrapResponse,
  ChatStartResponse,
  ShellResponse,
  UploadResourceResponse,
} from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { TEST_IDENTITY, testAuthAdapter } from "../helpers/test-auth-adapter.ts";

const API_KEY = "rest-workspace-path-test-key";
const testDir = join(tmpdir(), `nb-rest-workspace-path-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
/** Workspaces the caller belongs to. */
let wsA: string;
let wsB: string;
/** A workspace the caller does not belong to. */
let wsForeign: string;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: testAuthAdapter(API_KEY),
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  const store = runtime.getWorkspaceStore();
  wsA = (await store.create("Acme Corp")).id;
  wsB = (await store.create("Tenant A")).id;
  wsForeign = (await store.create("Elsewhere")).id;
  await store.addMember(wsA, TEST_IDENTITY.id, "admin");
  await store.addMember(wsB, TEST_IDENTITY.id, "admin");
  await store.addMember(wsForeign, "usr_someone_else", "admin");
  for (const id of [wsA, wsB]) await runtime.ensureWorkspaceRegistry(id);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

function send(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const isForm = opts.body instanceof FormData;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(opts.body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined
      ? { body: isForm ? (opts.body as FormData) : JSON.stringify(opts.body) }
      : {}),
  });
}

function uploadForm(): FormData {
  const form = new FormData();
  form.append("files", new File(["hello"], "note.txt", { type: "text/plain" }));
  return form;
}

/** One representative workspace-scoped request per router, relative to `/v1/workspaces/<wsId>`. */
const WORKSPACE_ROUTES: Array<{
  router: string;
  method: string;
  suffix: string;
  body?: () => unknown;
}> = [
  { router: "chat", method: "POST", suffix: "/chat/start", body: () => ({ message: "hi" }) },
  {
    router: "tools",
    method: "POST",
    suffix: "/tools/call",
    body: () => ({ server: "nb", tool: "manage_workspaces", arguments: { action: "list" } }),
  },
  { router: "tools", method: "GET", suffix: "/shell" },
  {
    router: "resources",
    method: "POST",
    suffix: "/resources/read",
    body: () => ({ server: "files", uri: "files://fl_000000000000000000000000" }),
  },
  { router: "resources", method: "POST", suffix: "/resources", body: uploadForm },
  { router: "resources", method: "GET", suffix: "/apps/conversations/resources/primary" },
  {
    router: "mcp-auth",
    method: "POST",
    suffix: "/mcp-auth/initiate",
    body: () => ({ serverName: "not-installed" }),
  },
];

/** Every retired workspace-scoped path, with the method it answered. */
const RETIRED_ROUTES: Array<{ method: string; path: string; body?: () => unknown }> = [
  { method: "POST", path: "/v1/chat", body: () => ({ message: "hi" }) },
  { method: "POST", path: "/v1/chat/stream", body: () => ({ message: "hi" }) },
  { method: "POST", path: "/v1/chat/start", body: () => ({ message: "hi" }) },
  { method: "GET", path: "/v1/shell" },
  {
    method: "POST",
    path: "/v1/resources/read",
    body: () => ({ server: "files", uri: "files://fl_000000000000000000000000" }),
  },
  { method: "POST", path: "/v1/resources", body: uploadForm },
  { method: "GET", path: "/v1/apps/conversations/resources/primary" },
  { method: "POST", path: "/v1/mcp-auth/initiate", body: () => ({ serverName: "x" }) },
  {
    method: "POST",
    path: "/v1/composio-auth/initiate",
    body: () => ({ connectorId: "com.acme/x" }),
  },
];

describe("retired workspace-scoped paths", () => {
  for (const route of RETIRED_ROUTES) {
    it(`${route.method} ${route.path} is not found, even naming a member workspace in the header`, async () => {
      const res = await send(route.method, route.path, {
        body: route.body?.(),
        headers: { "X-Workspace-Id": wsA },
      });
      expect(res.status).toBe(404);
      expect((await readJson<ApiErrorBody>(res)).error).toBe("not_found");
    });
  }
});

describe("a workspace the caller cannot reach", () => {
  for (const route of WORKSPACE_ROUTES) {
    it(`${route.router} ${route.method} …${route.suffix}: malformed, unknown and non-member ids answer identically`, async () => {
      const answers: Array<{ status: number; body: string }> = [];
      for (const wsId of ["ws_bad-id", "acme-corp", "ws_0000000000000000", wsForeign]) {
        const res = await send(route.method, `/v1/workspaces/${wsId}${route.suffix}`, {
          body: route.body?.(),
        });
        answers.push({ status: res.status, body: await res.text() });
      }
      expect(answers[0]!.status).toBe(404);
      expect(JSON.parse(answers[0]!.body).error).toBe("workspace_error");
      for (const answer of answers) expect(answer).toEqual(answers[0]!);
    });
  }

  it("a header naming the caller's own workspace does not admit a foreign path", async () => {
    const plain = await send("GET", `/v1/workspaces/${wsForeign}/shell`);
    const withHeader = await send("GET", `/v1/workspaces/${wsForeign}/shell`, {
      headers: { "X-Workspace-Id": wsA },
    });
    expect(withHeader.status).toBe(plain.status);
    expect(await withHeader.text()).toBe(await plain.text());
  });
});

describe("X-Workspace-Id has no effect on a workspace-scoped route", () => {
  it("the shell is the path's workspace's", async () => {
    const res = await send("GET", `/v1/workspaces/${wsA}/shell`, {
      headers: { "X-Workspace-Id": wsB },
    });
    expect(res.status).toBe(200);
    const plain = await send("GET", `/v1/workspaces/${wsA}/shell`);
    expect(await readJson<ShellResponse>(res)).toEqual(await readJson<ShellResponse>(plain));
  });

  it("a new conversation is born in the path's workspace", async () => {
    const res = await send("POST", `/v1/workspaces/${wsA}/chat/start`, {
      body: { message: "hello" },
      headers: { "X-Workspace-Id": wsB },
    });
    expect(res.status).toBe(200);
    const { conversationId } = await readJson<ChatStartResponse>(res);
    let conversation = await runtime.findConversation(conversationId);
    for (let i = 0; i < 50 && !conversation; i++) {
      await Bun.sleep(20);
      conversation = await runtime.findConversation(conversationId);
    }
    expect(conversation?.workspaceId).toBe(wsA);
  });

  it("a file upload lands in the path's workspace", async () => {
    const res = await send("POST", `/v1/workspaces/${wsA}/resources`, {
      body: uploadForm(),
      headers: { "X-Workspace-Id": wsB },
    });
    expect(res.status).toBe(200);
    const { files } = await readJson<UploadResourceResponse>(res);
    const fileId = files[0]!.id;
    const locator = runtime.getFileLocator();
    expect(await locator.resolve(TEST_IDENTITY.id, fileId)).toBe(wsA);
  });
});

describe("cross-site writes to a workspace route", () => {
  const listCall = { server: "nb", tool: "manage_workspaces", arguments: { action: "list" } };

  it("refuses a browser write marked same-site from an origin CORS does not allow", async () => {
    const res = await send("POST", `/v1/workspaces/${wsA}/tools/call`, {
      body: listCall,
      headers: { "Sec-Fetch-Site": "same-site", Origin: "https://tenant-a.example.com" },
    });
    expect(res.status).toBe(403);
    expect((await readJson<ApiErrorBody>(res)).error).toBe("cross_site_request");
  });

  it("admits the same write from the same origin", async () => {
    const res = await send("POST", `/v1/workspaces/${wsA}/tools/call`, {
      body: listCall,
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(200);
  });
});

describe("identity-scoped routes need no workspace", () => {
  it("bootstrap", async () => {
    const res = await send("GET", "/v1/bootstrap");
    expect(res.status).toBe(200);
    const body = await readJson<BootstrapResponse>(res);
    expect(body.workspaces.length).toBeGreaterThan(0);
  });

  it("health", async () => {
    expect((await send("GET", "/v1/health")).status).toBe(200);
  });

  it("the identity event stream", async () => {
    const res = await send("GET", "/v1/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("a conversation's event stream and cancel, located by conversation id", async () => {
    const started = await send("POST", `/v1/workspaces/${wsA}/chat/start`, {
      body: { message: "for the event stream" },
    });
    const { conversationId } = await readJson<ChatStartResponse>(started);

    const events = await send("GET", `/v1/conversations/${conversationId}/events`);
    expect(events.status).toBe(200);
    await events.body?.cancel();

    const cancel = await send("POST", `/v1/conversations/${conversationId}/cancel`);
    expect(cancel.status).toBeLessThan(400);
  });

  it("a file by its bare id", async () => {
    const uploaded = await send("POST", `/v1/workspaces/${wsB}/resources`, { body: uploadForm() });
    const { files } = await readJson<UploadResourceResponse>(uploaded);
    const res = await send("GET", `/v1/files/${files[0]!.id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });
});

describe("a name that carries a workspace", () => {
  // The workspace is the one in the path. A `ws_<id>-` qualified server, app or
  // tool is refused with a 400 — even naming a workspace the caller belongs to —
  // rather than routed there or stripped to its bare remainder.
  const QUALIFIED: Array<{
    label: string;
    method: string;
    suffix: () => string;
    body?: () => unknown;
  }> = [
    {
      label: "tools/call server",
      method: "POST",
      suffix: () => "/tools/call",
      body: () => ({
        server: `${wsB}-nb`,
        tool: "manage_workspaces",
        arguments: { action: "list" },
      }),
    },
    {
      label: "tools/call tool",
      method: "POST",
      suffix: () => "/tools/call",
      body: () => ({
        server: "nb",
        tool: `${wsB}-nb__manage_workspaces`,
        arguments: { action: "list" },
      }),
    },
    {
      label: "resources/read server",
      method: "POST",
      suffix: () => "/resources/read",
      body: () => ({ server: `${wsB}-nb`, uri: "ui://nb/main" }),
    },
    {
      label: "app resource proxy",
      method: "GET",
      suffix: () => `/apps/${encodeURIComponent(`${wsB}-nb`)}/resources/primary`,
    },
  ];

  for (const q of QUALIFIED) {
    it(`${q.label}: refused with a 400 naming the bare name`, async () => {
      const res = await send(q.method, `/v1/workspaces/${wsA}${q.suffix()}`, {
        ...(q.body ? { body: q.body() } : {}),
      });
      expect(res.status).toBe(400);
      const body = await readJson<ApiErrorBody>(res);
      expect(body.error).toBe("bad_request");
      expect(body.message).toContain("uses the retired ws_<id>-");
      expect(body.details.reason).toBe("legacy_namespaced_form");
    });
  }

  it("the bare name resolves in the path's workspace", async () => {
    const res = await send("POST", `/v1/workspaces/${wsA}/tools/call`, {
      body: { server: "nb", tool: "manage_workspaces", arguments: { action: "list" } },
    });
    expect(res.status).toBe(200);
  });
});
