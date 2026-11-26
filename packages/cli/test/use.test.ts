import { describe, expect, test } from "bun:test";
import { run } from "../src/main.ts";
import { ERRORS, FIX_VARIANTS } from "../src/result.ts";
import { WORKER_COMMAND } from "../src/subscription/command.ts";
import {
  CLAUDE_MAX,
  type MachineOptions,
  machine,
  missing,
  ok,
  REPO_COMPOSE,
  record,
} from "./fake.ts";

const HOME = "/home/dana/.nimblebrain-local";
const ENV = `${HOME}/.env`;
const RECORD = `${HOME}/agent-worker.json`;
const LOG = `${HOME}/agent-worker.log`;
const CLAUDE_STATUS = "claude auth status --json";
const CODEX_STATUS = "codex login status";

/** A ready install on a Mac, its Compose file the repo's (which takes the agent runtime). */
function mac(opts: MachineOptions = {}) {
  return machine({
    platform: "darwin",
    exec: { [CLAUDE_STATUS]: ok(CLAUDE_MAX), [CODEX_STATUS]: ok("Logged in using ChatGPT\n") },
    ...opts,
    files: {
      [`${HOME}/install.json`]: record(),
      [ENV]: "COMPOSE_PROJECT_NAME=nimblebrain-local-0a1b2c\nANTHROPIC_API_KEY=sk-test\n",
      [`${HOME}/docker-compose.yml`]: REPO_COMPOSE,
      ...opts.files,
    },
  });
}

async function json(argv: string[], m = mac()) {
  const { stdout, code } = await run([...argv, "--json"], m.deps);
  return { body: JSON.parse(stdout), code, m };
}

const envOf = (m: ReturnType<typeof mac>) => m.files.get(ENV)?.text ?? "";

describe("use claude", () => {
  test("starts the worker, points the runtime at it, and recreates the runtime", async () => {
    const { body, code, m } = await json(["use", "claude"]);

    expect(code).toBe(0);
    expect(body).toEqual({
      ok: true,
      agent_runtime: {
        name: "claude-code",
        worker: { running: true, pid: 4242, url: "http://127.0.0.1:27290/acp", log: LOG },
      },
      billed_to: "your Claude Max subscription (claude.ai login, no API key)",
      tools: "only your NimbleBrain workspace's tools",
    });
    // This CLI's own file, run by this Node, with the hidden worker command; its output to the log.
    expect(m.spawned).toEqual([
      {
        line: `/usr/local/bin/node /home/dana/.npm/_npx/1/nimblebrain.js ${WORKER_COMMAND} claude --port 27290`,
        logPath: LOG,
        env: m.deps.env,
      },
    ]);
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=claude-code\n");
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME_URL=http://host.docker.internal:27290/acp\n");
    // The key entered with `key` stays.
    expect(envOf(m)).toContain("ANTHROPIC_API_KEY=sk-test\n");
    expect(m.files.get(ENV)?.mode).toBe(0o600);
    expect(JSON.parse(m.files.get(RECORD)?.text ?? "{}")).toEqual({
      pid: 4242,
      port: 27290,
      agent: "claude-code",
    });
    expect(m.files.get(RECORD)?.mode).toBe(0o600);
    // `up -d` recreates the container, which is what makes it read `.env` again; after the worker answers.
    expect(m.calls.at(-1)).toBe(`${HOME}$ docker compose up -d --no-build`);
    expect(m.healthy).toBe(true);
  });

  test("checks the sign-in with no API key in Claude Code's environment", async () => {
    const m = mac({ env: { ANTHROPIC_API_KEY: "sk-shell", OPENAI_API_KEY: "sk-o", HOME: "/x" } });
    await json(["use", "claude"], m);
    const check = m.execEnvs.find((e) => e.line === CLAUDE_STATUS);
    expect(check?.env.HOME).toBe("/x");
    expect(check?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(check?.env.OPENAI_API_KEY).toBeUndefined();
  });

  test("--port moves the worker, and the URL the runtime dials with it", async () => {
    const { body, m } = await json(["use", "claude", "--port", "28000"]);
    expect(body.agent_runtime.worker.url).toBe("http://127.0.0.1:28000/acp");
    expect(m.spawned[0]?.line).toEndWith("--port 28000");
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME_URL=http://host.docker.internal:28000/acp\n");
  });

  test("a worker already running is stopped before the new one starts", async () => {
    const m = mac({
      workers: { 4100: { port: 27291, command: `node x.js ${WORKER_COMMAND} codex` } },
      files: { [RECORD]: JSON.stringify({ pid: 4100, port: 27291, agent: "codex" }) },
    });
    const { body } = await json(["use", "claude"], m);
    expect(m.calls).toContain("$ kill -TERM 4100");
    expect([...m.workers.keys()]).toEqual([body.agent_runtime.worker.pid]);
  });

  test("a recorded pid that is no longer a worker is never signalled", async () => {
    const m = mac({
      files: { [RECORD]: JSON.stringify({ pid: 999, port: 27290, agent: "claude-code" }) },
    });
    await json(["use", "claude"], m);
    expect(m.calls.some((c) => c.includes("kill"))).toBe(false);
  });
});

describe("use codex", () => {
  test("runs on the ChatGPT plan, on its own port, and says Codex keeps a shell", async () => {
    const { body, code, m } = await json(["use", "codex"]);
    expect(code).toBe(0);
    expect(body.agent_runtime.name).toBe("codex");
    expect(body.agent_runtime.worker.url).toBe("http://127.0.0.1:27291/acp");
    expect(body.billed_to).toBe("your ChatGPT plan (Sign in with ChatGPT, no API key)");
    expect(body.tools).toContain("read-only shell");
    expect(m.spawned[0]?.line).toContain(`${WORKER_COMMAND} codex --port 27291`);
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=codex\n");
  });
});

describe("use refuses", () => {
  /** A refusal changes nothing: no worker, no `.env` change, no restart. */
  function unchanged(m: ReturnType<typeof mac>) {
    expect(m.spawned).toEqual([]);
    expect(envOf(m)).not.toContain("NB_AGENT_RUNTIME");
    expect(m.calls.some((c) => c.includes("compose up"))).toBe(false);
  }

  test.each([
    ["claude", { [CLAUDE_STATUS]: missing() }, "AGENT_CLI_MISSING", "claude"],
    ["codex", { [CODEX_STATUS]: missing() }, "AGENT_CLI_MISSING", "codex"],
    ["claude", { [CLAUDE_STATUS]: ok("{}") }, "AGENT_NOT_SIGNED_IN", "claude"],
    ["codex", { [CODEX_STATUS]: ok("Not logged in\n") }, "AGENT_NOT_SIGNED_IN", "codex"],
    [
      "claude",
      { [CLAUDE_STATUS]: ok(JSON.stringify({ loggedIn: true, authMethod: "api_key" })) },
      "AGENT_BILLS_API_KEY",
      "claude",
    ],
    [
      "codex",
      { [CODEX_STATUS]: ok("Logged in using an API key - sk-***\n") },
      "AGENT_BILLS_API_KEY",
      "codex",
    ],
  ] as const)(
    "use %s: %p is %s, with the fix naming its command",
    async (arg, exec, code, variant) => {
      const m = mac({ exec });
      const { body } = await json(["use", arg], m);
      expect(body).toMatchObject({ ok: false, error: code });
      const fixes = FIX_VARIANTS[code] as Record<string, string>;
      expect(body.fix).toBe(fixes[variant]);
      expect(body.fix).toContain(variant === "claude" ? "`claude" : "`codex");
      unchanged(m);
    },
  );

  test("on Linux, whose container cannot reach the worker on 127.0.0.1", async () => {
    const m = mac({ platform: "linux" });
    const { body, code } = await json(["use", "claude"], m);
    expect(code).toBe(1);
    expect(body).toMatchObject({ error: "HOST_LOOPBACK_UNREACHABLE" });
    expect(body.fix).toBe(ERRORS.HOST_LOOPBACK_UNREACHABLE);
    expect(body.fix).toContain("Docker bridge");
    expect(m.calls).toEqual([]);
    unchanged(m);
  });

  test("on Windows, where the worker cannot be found or stopped without ps and kill", async () => {
    const m = mac({ platform: "win32" });
    const { body, code } = await json(["use", "claude"], m);
    expect(code).toBe(1);
    expect(body).toMatchObject({ error: "PLATFORM_UNSUPPORTED" });
    expect(body.fix).toBe(ERRORS.PLATFORM_UNSUPPORTED);
    expect(m.calls).toEqual([]);
    unchanged(m);
  });

  test("on a release whose Compose file does not pass the agent runtime", async () => {
    const old = REPO_COMPOSE.replace(/^.*NB_AGENT_RUNTIME.*\n/gm, "");
    const m = mac({ files: { [`${HOME}/docker-compose.yml`]: old } });
    const { body } = await json(["use", "claude"], m);
    expect(body).toMatchObject({ error: "RUNTIME_UNSUPPORTED" });
    unchanged(m);
  });

  test("when the worker's port is taken", async () => {
    const m = mac({ portFree: false });
    const { body } = await json(["use", "claude"], m);
    expect(body).toMatchObject({ error: "PORT_IN_USE" });
    expect(body.message).toContain("27290");
    unchanged(m);
  });

  test("when the worker stops before it answers, with its last log line", async () => {
    const m = mac({ worker: "refuses" });
    const { body } = await json(["use", "claude"], m);
    expect(body).toMatchObject({ error: "AGENT_WORKER_FAILED", log: LOG });
    expect(body.message).toContain("Not started: Claude Code is not signed in.");
    expect(m.files.get(RECORD)).toBeUndefined();
    expect(envOf(m)).not.toContain("NB_AGENT_RUNTIME");
  });

  test("without a runtime, or with another one, as a usage error", async () => {
    for (const argv of [["use"], ["use", "gemini"]]) {
      const { body, code } = await json(argv);
      expect(code).toBe(2);
      expect(body).toMatchObject({ error: "USAGE" });
    }
  });

  test("on an install that is not ready, or not there", async () => {
    const starting = mac({ files: { [`${HOME}/install.json`]: record({ phase: "starting" }) } });
    expect((await json(["use", "claude"], starting)).body.error).toBe("INSTALL_INCOMPLETE");
    const none = machine({ platform: "darwin" });
    expect((await json(["use", "claude"], none)).body.error).toBe("NOT_INSTALLED");
  });
});

describe("use native", () => {
  test("stops the worker, clears the runtime from .env, and recreates the runtime", async () => {
    const m = mac();
    await json(["use", "claude"], m);
    const { body, code } = await json(["use", "native"], m);
    expect(code).toBe(0);
    expect(body).toEqual({ ok: true, agent_runtime: { name: "native", worker: null } });
    expect(m.workers.size).toBe(0);
    expect(m.files.get(RECORD)).toBeUndefined();
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=\n");
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME_URL=\n");
    expect(m.calls.at(-1)).toBe(`${HOME}$ docker compose up -d --no-build`);
  });
});

describe("the worker across the install's life", () => {
  test("status reports the runtime and whether its worker runs", async () => {
    const m = mac();
    expect((await json(["status"], m)).body.agent_runtime).toEqual({
      name: "native",
      worker: null,
    });
    await json(["use", "claude"], m);
    expect((await json(["status"], m)).body.agent_runtime).toEqual({
      name: "claude-code",
      worker: { running: true, pid: 4242, url: "http://127.0.0.1:27290/acp", log: LOG },
    });
    m.workers.clear();
    expect((await json(["status"], m)).body.agent_runtime.worker).toEqual({
      running: false,
      pid: null,
      url: "http://127.0.0.1:27290/acp",
      log: LOG,
    });
    const { stdout } = await run(["status"], m.deps);
    expect(stdout).toContain("its agent worker is stopped (start it with npx nimblebrain up)");
  });

  test("up starts a configured worker that is not running, on the port the runtime dials", async () => {
    const m = mac();
    await json(["use", "claude", "--port", "28000"], m);
    m.workers.clear();
    const { body, code } = await json(["up"], m);
    expect(code).toBe(0);
    expect(m.spawned.at(-1)?.line).toEndWith(`${WORKER_COMMAND} claude --port 28000`);
    expect(body.agent_runtime.worker.running).toBe(true);
  });

  test("up leaves a running worker, and starts none on native", async () => {
    const m = mac();
    await json(["up"], m);
    expect(m.spawned).toEqual([]);
    await json(["use", "claude"], m);
    await json(["up"], m);
    expect(m.spawned.length).toBe(1);
  });

  test("up still starts NimbleBrain when the worker cannot start, and says why", async () => {
    const m = mac();
    await json(["use", "claude"], m);
    m.workers.clear();
    m.healthy = false;
    const signedOut = mac({
      exec: { [CLAUDE_STATUS]: ok("{}") },
      files: { [ENV]: envOf(m) },
    });
    const { body } = await json(["up"], signedOut);
    expect(body).toMatchObject({ ok: false, error: "AGENT_NOT_SIGNED_IN", health: "ok" });
    expect(body.message).toStartWith("NimbleBrain is running, but ");
  });

  test("down stops the worker and keeps the runtime in .env for up", async () => {
    const m = mac();
    await json(["use", "claude"], m);
    const { code } = await json(["down"], m);
    expect(code).toBe(0);
    expect(m.workers.size).toBe(0);
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=claude-code\n");
  });

  test("uninstall stops the worker and removes its record and log", async () => {
    const m = mac();
    await json(["use", "claude"], m);
    m.files.set(LOG, { text: "started\n", mode: 0o600 });
    const { code } = await json(["uninstall", "--yes"], m);
    expect(code).toBe(0);
    expect(m.workers.size).toBe(0);
    expect(m.files.has(RECORD)).toBe(false);
    expect(m.files.has(LOG)).toBe(false);
  });
});
