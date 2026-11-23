import { describe, expect, test } from "bun:test";
import { hostLoopback } from "../src/compose.ts";
import { run } from "../src/main.ts";
import { ERRORS } from "../src/result.ts";
import { type MachineOptions, machine, REPO_COMPOSE, record } from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const INSTALL = record({ version: "v0.80.0" });
/** A release's Compose file from before the runtime could reach this machine. */
const OLD_COMPOSE = REPO_COMPOSE.split("\n")
  .filter((l) => !l.includes("NB_HOST_LOOPBACK") && !l.includes("host-gateway"))
  .join("\n");

type Call = { server: string; tool: string; arguments: Record<string, unknown> };

/** A running install of the given Compose file, whose workspace tool calls are answered by `answer`. */
function running(opts: MachineOptions & { compose_text?: string } = {}) {
  const calls: Array<{ wsId: string; call: Call }> = [];
  const m = machine({
    ...opts,
    files: {
      [`${HOME}/install.json`]: INSTALL,
      [`${HOME}/docker-compose.yml`]: opts.compose_text ?? REPO_COMPOSE,
      ...opts.files,
    },
    workspaceToolCall: (wsId, call) => {
      calls.push({ wsId, call });
      return opts.workspaceToolCall?.(wsId, call) ?? { status: 200, body: { isError: false } };
    },
  });
  m.healthy = true;
  return Object.assign(m, { toolCalls: calls });
}

async function json(argv: string[], m: ReturnType<typeof running>) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code };
}

const coded = (error: string, text: string) => ({
  status: 200,
  body: {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: { ok: false, error },
  },
});

describe("mcp arguments", () => {
  test("each subcommand takes what it needs and nothing more", async () => {
    const m = running();
    for (const argv of [
      ["mcp"],
      ["mcp", "launch"],
      ["mcp", "add"],
      ["mcp", "remove"],
      ["mcp", "list", "extra"],
      ["mcp", "add", "http://127.0.0.1:8000/mcp", "extra"],
    ]) {
      const { body, code } = await json(argv, m);
      expect(code).toBe(2);
      expect(body.error).toBe("USAGE");
    }
    expect(m.toolCalls).toHaveLength(0);
  });

  test("add sends a direct-url install with the URL and --name, and no Origin", async () => {
    const m = running();
    await json(["mcp", "add", "http://127.0.0.1:8000/mcp", "--name", "notes"], m);
    expect(m.toolCalls).toEqual([
      {
        wsId: "ws_1",
        call: {
          server: "nb",
          tool: "manage_connectors",
          arguments: {
            action: "install",
            entry: {
              id: "direct-url",
              name: "notes",
              install: {
                kind: "direct-url",
                url: "http://127.0.0.1:8000/mcp",
                serverName: "notes",
              },
            },
          },
        },
      },
    ]);
  });

  test("a URL that is not http or https is URL_INVALID before anything is sent", async () => {
    const m = running();
    for (const url of ["notaurl", "file:///etc/passwd"]) {
      expect((await json(["mcp", "add", url], m)).body.error).toBe("URL_INVALID");
    }
    expect(m.toolCalls).toHaveLength(0);
  });
});

describe("mcp add", () => {
  test("answers the runtime's serverName, url, dialed, placements, wsId and warning", async () => {
    const structured = {
      ok: true,
      serverName: "notes",
      url: "http://127.0.0.1:8000/mcp",
      dialed: "http://host.docker.internal:8000/mcp",
      placements: [{ slot: "sidebar", label: "Notes" }],
      wsId: "ws_1",
      warning: "connect ECONNREFUSED",
    };
    const m = running({
      workspaceToolCall: () => ({
        status: 200,
        body: { isError: false, structuredContent: structured },
      }),
    });
    const { body, code } = await json(["mcp", "add", "http://127.0.0.1:8000/mcp"], m);
    expect(code).toBe(0);
    expect(body).toEqual(structured);
  });

  test("a person reads the placements, not [object Object]", async () => {
    const m = running({
      workspaceToolCall: () => ({
        status: 200,
        body: {
          isError: false,
          structuredContent: {
            serverName: "notes",
            placements: [{ slot: "sidebar" }],
            wsId: "ws_1",
          },
        },
      }),
    });
    const { stdout } = await run(["mcp", "add", "http://127.0.0.1:8000/mcp"], m.deps);
    expect(stdout).toContain('placements: {"slot":"sidebar"}');
    expect(stdout).not.toContain("[object Object]");
  });

  test("each coded refusal from the runtime is the CLI code of the same name, with its message", async () => {
    for (const code of [
      "DIRECT_URL_NOT_ALLOWED",
      "URL_NOT_LOOPBACK",
      "URL_INVALID",
      "INVALID_SERVER_NAME",
      "NAME_TAKEN",
      "NAME_IS_CATALOG_ENTRY",
    ] as const) {
      const m = running({ workspaceToolCall: () => coded(code, `refused: ${code}`) });
      const { body, code: exit } = await json(["mcp", "add", "http://127.0.0.1:8000/mcp"], m);
      expect(exit).toBe(1);
      expect(body).toMatchObject({ ok: false, error: code, message: `refused: ${code}` });
      expect(body.fix).toBe(ERRORS[code]);
    }
  });

  test("an uncoded refusal is REQUEST_FAILED carrying the runtime's text", async () => {
    const m = running({
      workspaceToolCall: () => ({
        status: 200,
        body: { isError: true, content: [{ type: "text", text: "Authentication required." }] },
      }),
    });
    const { body } = await json(["mcp", "add", "http://127.0.0.1:8000/mcp"], m);
    expect(body).toMatchObject({ error: "REQUEST_FAILED", message: "Authentication required." });
  });

  test("a refused request is REQUEST_FAILED with its status", async () => {
    const m = running({
      workspaceToolCall: () => ({
        status: 403,
        body: { error: "untrusted_origin", message: "Request origin is not trusted" },
      }),
    });
    const { body } = await json(["mcp", "add", "http://127.0.0.1:8000/mcp"], m);
    expect(body).toMatchObject({ error: "REQUEST_FAILED", status: 403 });
  });

  test("an install whose Compose file predates host loopback is UPDATE_REQUIRED, sending nothing", async () => {
    const m = running({ compose_text: OLD_COMPOSE });
    const { body } = await json(["mcp", "add", "http://127.0.0.1:8000/mcp"], m);
    expect(body).toMatchObject({ ok: false, error: "UPDATE_REQUIRED" });
    expect(body.fix).toContain("npx nimblebrain update");
    expect(m.toolCalls).toHaveLength(0);
  });

  test("list and remove do not need host loopback", async () => {
    const m = running({
      compose_text: OLD_COMPOSE,
      workspaceToolCall: () => ({ status: 200, body: { structuredContent: { installed: [] } } }),
    });
    expect((await json(["mcp", "list"], m)).body.ok).toBe(true);
  });
});

describe("mcp workspace and instance", () => {
  const two = [
    { id: "ws_a", name: "First" },
    { id: "ws_b", name: "Second" },
  ];

  test("defaults to the first workspace, the one init connected; --workspace overrides", async () => {
    const m = running({ workspaces: two });
    await json(["mcp", "list"], m);
    await json(["mcp", "list", "--workspace", "ws_b"], m);
    expect(m.toolCalls.map((c) => c.wsId)).toEqual(["ws_a", "ws_b"]);
  });

  test("a --workspace this install does not have is WORKSPACE_NOT_FOUND, naming the ones it has", async () => {
    const m = running({ workspaces: two });
    const { body } = await json(["mcp", "list", "--workspace", "ws_z"], m);
    expect(body).toMatchObject({ error: "WORKSPACE_NOT_FOUND", workspaces: ["ws_a", "ws_b"] });
    expect(m.toolCalls).toHaveLength(0);
  });

  test("the runtime's workspace_error is WORKSPACE_NOT_FOUND", async () => {
    const m = running({
      workspaceToolCall: () => ({
        status: 404,
        body: { error: "workspace_error", message: "Workspace not found" },
      }),
    });
    expect((await json(["mcp", "list"], m)).body.error).toBe("WORKSPACE_NOT_FOUND");
  });

  test("no install is NOT_INSTALLED; a stopped one is NOT_RUNNING", async () => {
    const none = running({ files: { [`${HOME}/install.json`]: "" } });
    expect((await json(["mcp", "list"], none)).body.error).toBe("NOT_INSTALLED");
    const stopped = running();
    stopped.healthy = false;
    expect((await json(["mcp", "list"], stopped)).body.error).toBe("NOT_RUNNING");
  });

  test("a call that gets no answer is NOT_RUNNING", async () => {
    const m = running();
    m.deps.postJson = async () => undefined;
    expect((await json(["mcp", "list"], m)).body.error).toBe("NOT_RUNNING");
  });
});

describe("mcp list and remove", () => {
  const installed = [
    {
      serverName: "notes",
      displayName: "Notes",
      url: "http://127.0.0.1:8000/mcp",
      state: "running",
      status: "ready",
      toolCount: 3,
      allowedTools: ["save_note"],
    },
  ];
  const answer = (_ws: string, call: Call) =>
    call.arguments.action === "list_installed"
      ? { status: 200, body: { isError: false, structuredContent: { installed } } }
      : { status: 200, body: { isError: false, structuredContent: { ok: true } } };

  test("list asks for the workspace's connectors and answers each one's name, URL and status", async () => {
    const m = running({ workspaceToolCall: answer });
    const { body } = await json(["mcp", "list"], m);
    expect(m.toolCalls[0]?.call.arguments).toEqual({
      action: "list_installed",
      scope: "workspace",
    });
    expect(body).toEqual({
      ok: true,
      wsId: "ws_1",
      servers: [
        {
          serverName: "notes",
          displayName: "Notes",
          url: "http://127.0.0.1:8000/mcp",
          state: "running",
          status: "ready",
          toolCount: 3,
        },
      ],
    });
    const { stdout } = await run(["mcp", "list"], m.deps);
    expect(stdout).toContain("notes: http://127.0.0.1:8000/mcp (ready)");
  });

  test("remove uninstalls a server the workspace has", async () => {
    const m = running({ workspaceToolCall: answer });
    const { body } = await json(["mcp", "remove", "notes"], m);
    expect(body).toEqual({ ok: true, serverName: "notes", wsId: "ws_1" });
    expect(m.toolCalls.at(-1)?.call.arguments).toEqual({
      action: "uninstall",
      serverName: "notes",
    });
  });

  test("remove of a name the workspace does not have is SERVER_NOT_FOUND, uninstalling nothing", async () => {
    const m = running({ workspaceToolCall: answer });
    const { body } = await json(["mcp", "remove", "other"], m);
    expect(body).toMatchObject({ ok: false, error: "SERVER_NOT_FOUND", wsId: "ws_1" });
    expect(m.toolCalls.map((c) => c.call.arguments.action)).toEqual(["list_installed"]);
  });
});

describe("status.host_loopback", () => {
  test("is read from the installed Compose file", async () => {
    expect(hostLoopback(REPO_COMPOSE)).toBe(true);
    expect(hostLoopback(OLD_COMPOSE)).toBe(false);
    expect((await json(["status"], running())).body.host_loopback).toBe(true);
    const old = running({ compose_text: OLD_COMPOSE });
    expect((await json(["status"], old)).body.host_loopback).toBe(false);
    const { stdout } = await run(["status"], old.deps);
    expect(stdout).toContain("npx nimblebrain update");
  });

  test("the release's Compose file maps the host and sets the alias the runtime dials", () => {
    expect(REPO_COMPOSE).toContain("host.docker.internal:host-gateway");
    expect(REPO_COMPOSE).toContain("NB_HOST_LOOPBACK=host.docker.internal");
  });
});
