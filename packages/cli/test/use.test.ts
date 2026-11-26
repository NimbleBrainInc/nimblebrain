import { describe, expect, test } from "bun:test";
import { run } from "../src/main.ts";
import { ERRORS, FIX_VARIANTS } from "../src/result.ts";
import { defaultSource, detectSources, pickerLines } from "../src/source.ts";
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
const BUNDLE = "/home/dana/.npm/_npx/1/nimblebrain.js";
const LABEL = "ai.nimblebrain.agent-worker.nimblebrain-local-0a1b2c";
const PLIST = `/home/dana/Library/LaunchAgents/${LABEL}.plist`;
const BIN = `${HOME}/bin/nimblebrain.mjs`;
const CODEX_STATUS = "codex login status";

/** A ready install on a Mac, its Compose file the repo's (which takes the agent runtime). */
function mac(opts: MachineOptions = {}) {
  return machine({
    platform: "darwin",
    ...opts,
    exec: {
      [CLAUDE_STATUS]: ok(CLAUDE_MAX),
      [CODEX_STATUS]: ok("Logged in using ChatGPT\n"),
      ...opts.exec,
    },
    files: {
      [`${HOME}/install.json`]: record(),
      [ENV]: "COMPOSE_PROJECT_NAME=nimblebrain-local-0a1b2c\nANTHROPIC_API_KEY=sk-test\n",
      [`${HOME}/docker-compose.yml`]: REPO_COMPOSE,
      // The published CLI file npx runs, which the login item copies into the home.
      [BUNDLE]: "// nimblebrain 0.9.0\n",
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
      model_source: {
        source: "claude",
        label: "your Claude Max subscription through Claude Code (Sonnet)",
        model: "sonnet",
      },
      agent_runtime: {
        name: "claude-code",
        worker: {
          running: true,
          pid: 4242,
          url: "http://127.0.0.1:27290/acp",
          log: LOG,
          login_item: PLIST,
        },
      },
      billed_to: "your Claude Max subscription (claude.ai login, no API key)",
      tools: "only your NimbleBrain workspace's tools",
    });
    // launchd runs the home's copy of this CLI with this Node and the hidden worker command; its output to the log.
    expect(m.spawned).toEqual([
      {
        line: `/usr/local/bin/node ${BIN} ${WORKER_COMMAND} claude --port 27290 --model sonnet --log ${LOG}`,
        logPath: LOG,
      },
    ]);
    expect(m.calls).toContain(`$ launchctl bootstrap gui/501 ${PLIST}`);
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=claude-code\n");
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME_URL=http://host.docker.internal:27290/acp\n");
    // The key entered with `key` stays.
    expect(envOf(m)).toContain("ANTHROPIC_API_KEY=sk-test\n");
    expect(m.files.get(ENV)?.mode).toBe(0o600);
    expect(JSON.parse(m.files.get(RECORD)?.text ?? "{}")).toEqual({
      port: 27290,
      agent: "claude-code",
      plan: "Claude Max",
      label: LABEL,
      model: "sonnet",
    });
    expect(m.files.get(RECORD)?.mode).toBe(0o600);
    // `up -d` recreates the container, which is what makes it read `.env` again; after the worker answers.
    expect(m.calls.findLast((c) => c.includes("docker"))).toBe(
      `${HOME}$ docker compose up -d --no-build`,
    );
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
    expect(m.spawned[0]?.line).toContain("--port 28000 ");
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

  test("without a source and no person to ask, or with another one, as a usage error", async () => {
    for (const argv of [["use"], ["use", "gemini"], ["use", "native"], ["use", "claude", "m"]]) {
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

const GEMMA = { capabilities: ["completion", "tools"] };
const LOCAL_ENV =
  "NB_LOCAL_MODEL_URL=http://host.docker.internal:11434/v1\nNB_LOCAL_MODEL=nimblebrain-gemma4-e4b\nNB_LOCAL_MODEL_CONTEXT=32768\n";

describe("use api", () => {
  test("leaves the subscription and the local model for the saved key, and recreates the runtime", async () => {
    const m = mac({ files: { [ENV]: `ANTHROPIC_API_KEY=sk-test\n${LOCAL_ENV}` } });
    await json(["use", "claude"], m);
    const { body, code } = await json(["use", "api"], m);
    expect(code).toBe(0);
    expect(body).toEqual({
      ok: true,
      model_source: { source: "api", label: "an API key (anthropic)", model: null },
      agent_runtime: { name: "native", worker: null },
      provider: "anthropic",
    });
    expect(m.workers.size).toBe(0);
    expect(m.files.get(RECORD)).toBeUndefined();
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=\n");
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME_URL=\n");
    expect(envOf(m)).toContain("NB_LOCAL_MODEL=\n");
    expect(envOf(m)).toContain("ANTHROPIC_API_KEY=sk-test\n");
    expect(m.calls.findLast((c) => c.includes("docker"))).toBe(
      `${HOME}$ docker compose up -d --no-build`,
    );
  });

  test("with no key and no terminal, is MODEL_KEY_MISSING and changes nothing", async () => {
    const m = mac({ files: { [ENV]: "COMPOSE_PROJECT_NAME=nimblebrain-local-0a1b2c\n" } });
    await json(["use", "claude"], m);
    const before = envOf(m);
    const calls = m.calls.length;
    const { body, code } = await json(["use", "api"], m);
    expect(code).toBe(1);
    expect(body).toMatchObject({ ok: false, error: "MODEL_KEY_MISSING" });
    expect(body.fix).toBe(ERRORS.MODEL_KEY_MISSING);
    expect(body.fix).toContain("`npx nimblebrain key`");
    expect(envOf(m)).toBe(before);
    expect(m.workers.size).toBe(1);
    expect(m.calls.slice(calls).some((c) => c.includes("compose up") || c.includes("kill"))).toBe(
      false,
    );
  });

  test("with no key at a terminal, asks for one at the hidden prompt", async () => {
    const m = mac({
      interactive: true,
      answers: ["", "sk-typed"],
      files: { [ENV]: "COMPOSE_PROJECT_NAME=nimblebrain-local-0a1b2c\n" },
    });
    const { stdout, code } = await run(["use", "api"], m.deps);
    expect(code).toBe(0);
    expect(m.asked[1]).toStartWith("ANTHROPIC_API_KEY");
    expect(envOf(m)).toContain("ANTHROPIC_API_KEY=sk-typed\n");
    expect(stdout).not.toContain("sk-typed");
    expect(stdout).toContain("NimbleBrain's agents now run on an API key (anthropic).");
  });
});

describe("use local", () => {
  test("prepares the default model, leaves the subscription, and keeps the key", async () => {
    const m = mac({ ollama: { models: { "gemma4:e4b": GEMMA } } });
    await json(["use", "claude"], m);
    const { body, code } = await json(["use", "local"], m);
    expect(code).toBe(0);
    expect(body).toEqual({
      ok: true,
      model_source: {
        source: "local",
        label: "a local model (nimblebrain-gemma4-e4b) through Ollama",
        model: null,
      },
      agent_runtime: { name: "native", worker: null },
      local_model: "nimblebrain-gemma4-e4b",
    });
    expect(m.workers.size).toBe(0);
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=\n");
    expect(envOf(m)).toContain("NB_LOCAL_MODEL=nimblebrain-gemma4-e4b\n");
    expect(envOf(m)).toContain("ANTHROPIC_API_KEY=sk-test\n");
    expect(m.calls.findLast((c) => c.includes("docker"))).toBe(
      `${HOME}$ docker compose up -d --no-build`,
    );
  });

  test("takes the model to run, as local-model does", async () => {
    const m = mac({ ollama: { models: { "qwen3:8b": GEMMA } } });
    const { body } = await json(["use", "local", "qwen3:8b"], m);
    expect(body.local_model).toBe("nimblebrain-qwen3-8b");
  });

  test("keeps a saved local model rather than preparing another", async () => {
    const m = mac({
      ollama: { models: { "nimblebrain-gemma4-e4b": GEMMA } },
      files: { [ENV]: LOCAL_ENV },
    });
    await json(["use", "claude"], m);
    const { body } = await json(["use", "local"], m);
    expect(body.local_model).toBe("nimblebrain-gemma4-e4b");
    expect(m.posts.some((p) => p.url.endsWith("/api/create"))).toBe(false);
  });

  test("an Ollama that does not answer is LOCAL_MODEL_UNREACHABLE, and the subscription stays", async () => {
    const m = mac();
    await json(["use", "claude"], m);
    const { body } = await json(["use", "local"], m);
    expect(body.error).toBe("LOCAL_MODEL_UNREACHABLE");
    expect(m.workers.size).toBe(1);
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=claude-code\n");
  });
});

describe("what this machine offers", () => {
  const detect = (m: ReturnType<typeof mac>) => detectSources(m.deps, envOf(m), REPO_COMPOSE);

  test("a signed-in Claude subscription is found, named by its plan, and is the default", async () => {
    const options = await detect(mac({ ollama: { models: {} } }));
    expect(options.map((o) => [o.source, o.available, o.detected])).toEqual([
      ["claude", true, true],
      ["codex", true, true],
      ["api", true, true],
      ["local", true, true],
    ]);
    expect(options[0]?.label).toBe("Your Claude Max subscription, through Claude Code");
    expect(options[2]?.note).toBe("your anthropic key is saved");
    expect(options[3]?.note).toBe("Ollama is running");
    expect(defaultSource(options)).toBe("claude");
  });

  test("the default is Codex when only it is signed in, else an API key", async () => {
    const codexOnly = await detect(mac({ exec: { [CLAUDE_STATUS]: ok("{}") } }));
    expect(codexOnly[0]).toMatchObject({ detected: false, note: "not signed in" });
    expect(defaultSource(codexOnly)).toBe("codex");
    const neither = await detect(
      mac({ exec: { [CLAUDE_STATUS]: missing(), [CODEX_STATUS]: ok("Not logged in\n") } }),
    );
    expect(neither[0]?.note).toBe("Claude Code is not installed");
    expect(defaultSource(neither)).toBe("api");
  });

  test("off macOS, neither subscription is offered, and neither CLI is run", async () => {
    const m = mac({ platform: "linux" });
    const options = await detect(m);
    expect(options.slice(0, 2).map((o) => [o.available, o.note])).toEqual([
      [false, "macOS only for now"],
      [false, "macOS only for now"],
    ]);
    expect(defaultSource(options)).toBe("api");
    expect(m.calls).toEqual([]);
    expect(pickerLines(options).filter((l) => l.startsWith("  Not here:"))).toHaveLength(2);
  });
});

describe("use with no source", () => {
  test("asks a person, listing what is found, and Enter takes the signed-in Claude subscription", async () => {
    const m = mac({ interactive: true, answers: [""], ollama: { models: {} } });
    const { code } = await run(["use"], m.deps);
    expect(code).toBe(0);
    expect(m.said.slice(0, 5)).toEqual([
      "How should NimbleBrain's agents run?",
      "  1) Your Claude Max subscription, through Claude Code              (signed in)",
      "  2) Your ChatGPT plan, through Codex                               (signed in)",
      "  3) An API key for a hosted model (Anthropic, OpenAI, Google, …)   (your anthropic key is saved)",
      "  4) A local model through Ollama                                   (Ollama is running)",
    ]);
    expect(m.asked).toEqual(["Choose 1-4, or claude, codex, api, local [1]: "]);
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=claude-code\n");
  });

  test.each([["2"], ["codex"], [" Codex "]])("takes %p as Codex", async (answer) => {
    const m = mac({ interactive: true, answers: [answer] });
    await run(["use"], m.deps);
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME=codex\n");
  });

  test("asks again after an answer that is neither a number nor a name", async () => {
    const m = mac({ interactive: true, answers: ["9", "api"] });
    const { code } = await run(["use"], m.deps);
    expect(code).toBe(0);
    expect(m.asked).toHaveLength(2);
    expect(m.said).toContain('"9" is not one of them.');
    expect(envOf(m)).not.toContain("NB_AGENT_RUNTIME=claude-code");
  });

  test("never chooses under --yes or --json, even at a terminal", async () => {
    for (const flag of ["--yes", "--json"]) {
      const m = mac({ interactive: true });
      const { stdout, code } = await run(["use", flag, "--json"], m.deps);
      expect(code).toBe(2);
      expect(JSON.parse(stdout)).toMatchObject({ error: "USAGE" });
      expect(JSON.parse(stdout).message).toContain("claude, codex, api or local");
      expect(m.asked).toEqual([]);
      expect(m.spawned).toEqual([]);
    }
  });
});

describe("init and the source", () => {
  const fresh = (opts: MachineOptions = {}) =>
    machine({
      platform: "darwin",
      env: { NIMBLEBRAIN_TAG: "v0.73.0" },
      exec: { [CLAUDE_STATUS]: ok(CLAUDE_MAX), [CODEX_STATUS]: ok("Logged in using ChatGPT\n") },
      ...opts,
    });

  test("--use claude starts the worker and writes .env before the one first start", async () => {
    const m = fresh();
    const envAtStart: string[] = [];
    const exec = m.deps.exec;
    m.deps.exec = async (cmd, args, o) => {
      if (args.join(" ").startsWith("compose up")) envAtStart.push(m.files.get(ENV)?.text ?? "");
      return exec(cmd, args, o);
    };
    const { body, code } = await json(["--yes", "--use", "claude", "--agent", "none"], m);
    expect(code).toBe(0);
    expect(envAtStart).toHaveLength(1);
    expect(envAtStart[0]).toContain("NB_AGENT_RUNTIME=claude-code\n");
    expect(m.spawned).toHaveLength(1);
    expect(body.model_source).toEqual({
      source: "claude",
      label: "your Claude Max subscription through Claude Code (Sonnet)",
      model: "sonnet",
    });
    expect(body.agent_runtime.worker.running).toBe(true);
  });

  test("under --yes without --use, chooses nothing and hands the question on", async () => {
    const m = fresh();
    const { body, code } = await json(["--yes", "--agent", "none"], m);
    expect(code).toBe(0);
    expect(m.asked).toEqual([]);
    expect(m.spawned).toEqual([]);
    expect(envOf(m)).not.toContain("NB_AGENT_RUNTIME");
    expect(body.model_key).toBe("missing");
    expect(body.model_source).toMatchObject({
      source: null,
      label: null,
      ask: "How should NimbleBrain's agents run?",
      default: "claude",
      set: "npx nimblebrain use claude|codex|api|local",
    });
    expect(body.model_source.options.map((o: { source: string }) => o.source)).toEqual([
      "claude",
      "codex",
      "api",
      "local",
    ]);
    expect(body.model_source.options[0]).toMatchObject({ detected: true, note: "signed in" });
  });

  test("a person at the terminal takes the default with Enter: the signed-in Claude subscription", async () => {
    const m = fresh({ interactive: true, answers: ["", "", "none"] });
    const { stdout, code } = await run([], m.deps);
    expect(code).toBe(0);
    expect(m.asked[1]).toBe("Choose 1-4, or claude, codex, api, local [1]: ");
    expect(m.asked.some((q) => q.includes("API_KEY"))).toBe(false);
    expect(stdout).toContain(
      "agents run on: your Claude Max subscription through Claude Code (Sonnet); agent worker 4242",
    );
    expect(stdout).not.toContain("Next: choose");
  });

  test("--use and --local-model disagree as a usage error", async () => {
    const { body, code } = await json(["--use", "api", "--local-model", "gemma4:e4b"], fresh());
    expect(code).toBe(2);
    expect(body.error).toBe("USAGE");
  });
});

describe("status names the source", () => {
  test.each([
    ["ANTHROPIC_API_KEY=sk-test\n", "api", "an API key (anthropic)"],
    [
      `ANTHROPIC_API_KEY=sk-test\n${LOCAL_ENV}`,
      "local",
      "a local model (nimblebrain-gemma4-e4b) through Ollama",
    ],
    ["", null, null],
  ] as const)("%p is %p", async (envText, source, label) => {
    const m = mac({ files: { [ENV]: envText } });
    expect((await json(["status"], m)).body.model_source).toEqual({ source, label, model: null });
    const { stdout } = await run(["status"], m.deps);
    expect(stdout).toContain(
      `agents run on: ${label ?? "nothing yet (choose with npx nimblebrain use)"}`,
    );
  });

  test("a subscription wins over a saved key, and is named with its plan while its worker runs", async () => {
    const m = mac();
    await json(["use", "claude"], m);
    expect((await json(["status"], m)).body.model_source).toEqual({
      source: "claude",
      label: "your Claude Max subscription through Claude Code (Sonnet)",
      model: "sonnet",
    });
    const { stdout } = await run(["status"], m.deps);
    expect(stdout).toContain(
      "agents run on: your Claude Max subscription through Claude Code (Sonnet); agent worker 4242 at http://127.0.0.1:27290/acp",
    );
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
      worker: {
        running: true,
        pid: 4242,
        url: "http://127.0.0.1:27290/acp",
        log: LOG,
        login_item: PLIST,
      },
    });
    m.workers.clear();
    expect((await json(["status"], m)).body.agent_runtime.worker).toEqual({
      running: false,
      pid: null,
      url: "http://127.0.0.1:27290/acp",
      log: LOG,
      login_item: PLIST,
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
    expect(m.spawned.at(-1)?.line).toContain(`${WORKER_COMMAND} claude --port 28000 `);
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

describe("the worker's login item", () => {
  const plistOf = (m: ReturnType<typeof mac>) => m.files.get(PLIST)?.text ?? "";

  test("use installs a LaunchAgent that starts the worker at login and after a crash", async () => {
    const m = mac({
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin",
        ANTHROPIC_API_KEY: "sk-shell",
        HOME: "/home/dana",
      },
    });
    await json(["use", "claude"], m);
    const text = plistOf(m);
    expect(text).toContain(`<key>Label</key>\n    <string>${LABEL}</string>`);
    expect(text).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(text).toContain("<key>SuccessfulExit</key>\n      <false/>");
    expect(text).toContain(`<key>StandardOutPath</key>\n    <string>${LOG}</string>`);
    expect(text).toContain(`<key>StandardErrorPath</key>\n    <string>${LOG}</string>`);
    // launchd's own PATH would not find claude; never a key in a file anyone on this account reads.
    expect(text).toContain("<key>PATH</key>\n      <string>/opt/homebrew/bin:/usr/bin</string>");
    expect(text).not.toContain("sk-shell");
    expect(text).not.toContain(".npm/_npx");
    // npx's cache is cleaned, so the item runs a copy of this CLI in the home.
    expect(m.files.get(BIN)).toEqual({ text: "// nimblebrain 0.9.0\n", mode: 0o600 });
    expect(m.calls.some((c) => c.includes("sudo"))).toBe(false);
  });

  test("runs the bundle npx's .bin link points at from a copy, and finds the vendor CLI without npx's cache", async () => {
    // What `Deps.self` holds once npx's `.bin/nimblebrain` link is resolved: the package's bundle.
    const bundle = "/home/dana/.npm/_npx/9f/node_modules/nimblebrain/dist/nimblebrain.js";
    const m = mac({
      programs: ["claude"],
      files: { [bundle]: "// nimblebrain 0.9.0\n" },
      env: {
        PATH: "/home/dana/.npm/_npx/9f/node_modules/.bin:/usr/bin:/opt/homebrew/bin",
        HOME: "/home/dana",
      },
    });
    m.deps.self = { ...m.deps.self, script: bundle };
    await json(["use", "claude"], m);
    expect(m.files.get(BIN)?.text).toBe("// nimblebrain 0.9.0\n");
    expect(m.spawned[0]?.line).toStartWith(`/usr/local/bin/node ${BIN} `);
    // The resolved claude's folder first, then the shell's PATH without npx's cache.
    expect(plistOf(m)).toContain(
      "<key>PATH</key>\n      <string>/opt/homebrew/bin:/usr/bin</string>",
    );
    expect(plistOf(m)).not.toContain("_npx");
  });

  test("an entry without an extension is copied too; only a source checkout's .ts runs in place", async () => {
    const entry = "/home/dana/.local/lib/nimblebrain/cli";
    const m = mac({ files: { [entry]: "// nimblebrain\n" } });
    m.deps.self = { ...m.deps.self, script: entry };
    await json(["use", "claude"], m);
    expect(m.spawned[0]?.line).toStartWith(`/usr/local/bin/node ${BIN} `);
    const src = mac();
    src.deps.self = {
      ...src.deps.self,
      script: "/home/dana/src/nimblebrain/packages/cli/src/bin.ts",
    };
    await json(["use", "claude"], src);
    expect(src.spawned[0]?.line).toContain("/packages/cli/src/bin.ts __agent-worker");
    expect(src.files.has(BIN)).toBe(false);
  });

  test("its text says the worker starts at login", async () => {
    const { stdout } = await run(["use", "claude"], mac().deps);
    expect(stdout).toContain(
      `starts at login: ${PLIST} (launchd starts the worker when you log in, and again if it crashes)`,
    );
  });

  test("use api, use local, down and uninstall remove it; up puts it back", async () => {
    const m = mac({
      ollama: { models: { "gemma4:e4b": { capabilities: ["completion", "tools"] } } },
    });
    for (const off of [["use", "api"], ["use", "local"], ["down"]]) {
      await json(["use", "claude"], m);
      expect(m.loaded.has(LABEL)).toBe(true);
      const { code } = await json(off, m);
      expect(code).toBe(0);
      expect(m.loaded.has(LABEL)).toBe(false);
      expect(m.files.has(PLIST)).toBe(false);
      expect(m.workers.size).toBe(0);
    }
    await json(["up"], m);
    expect(m.loaded.has(LABEL)).toBe(true);
    await json(["uninstall", "--yes"], m);
    expect(m.loaded.has(LABEL)).toBe(false);
    expect(m.files.has(PLIST)).toBe(false);
    expect(m.files.has(BIN)).toBe(false);
  });

  test("up leaves a current, answering worker alone, and reinstalls one whose Node moved", async () => {
    const m = mac();
    await json(["use", "claude"], m);
    const loads = () => m.calls.filter((c) => c.includes("launchctl bootstrap")).length;
    await json(["up"], m);
    expect(loads()).toBe(1);
    m.deps.self = { ...m.deps.self, node: "/home/dana/.nvm/versions/node/v24.1.0/bin/node" };
    await json(["up"], m);
    expect(loads()).toBe(2);
    expect(plistOf(m)).toContain("<string>/home/dana/.nvm/versions/node/v24.1.0/bin/node</string>");
    expect(m.workers.size).toBe(1);
  });

  test("update refreshes it with the newer CLI file", async () => {
    const m = mac({ tags: ["v0.73.0"] });
    await json(["use", "claude"], m);
    m.files.set(BUNDLE, { text: "// nimblebrain 0.9.1\n", mode: 0o644 });
    const { code } = await json(["update"], m);
    expect(code).toBe(0);
    expect(m.files.get(BIN)?.text).toBe("// nimblebrain 0.9.1\n");
    expect(m.loaded.has(LABEL)).toBe(true);
  });

  test("a worker that exits before answering is removed again, with its last log line", async () => {
    const m = mac({ worker: "refuses" });
    const { body } = await json(["use", "claude"], m);
    expect(body).toMatchObject({ error: "AGENT_WORKER_FAILED", log: LOG });
    expect(body.message).toContain("Not started: Claude Code is not signed in.");
    expect(m.loaded.has(LABEL)).toBe(false);
    expect(m.files.has(PLIST)).toBe(false);
  });

  test("status judges the worker by its /healthz, not by a pid", async () => {
    const m = mac();
    await json(["use", "claude"], m);
    // launchd restarted it under another pid: still running.
    const [[pid, w] = [0, { port: 0, command: "" }]] = [...m.workers];
    m.workers.delete(pid);
    m.workers.set(5000, w);
    m.loaded.set(LABEL, { pid: 5000 });
    const { body } = await json(["status"], m);
    expect(body.agent_runtime.worker).toMatchObject({ running: true, pid: 5000 });
  });
});

describe("a worker that drains before it lets go of its port", () => {
  const plistOf = (m: ReturnType<typeof mac>) => m.files.get(PLIST)?.text ?? "";
  /** On Claude, whose worker holds 27290 for 3 s after launchd stops it. */
  async function draining(opts: MachineOptions = {}) {
    const m = mac({ tags: ["v0.73.0"], drainMs: 3_000, ...opts });
    await json(["use", "claude"], m);
    return m;
  }

  test.each([
    [
      "update, with a newer CLI file",
      (m: ReturnType<typeof mac>) =>
        m.files.set(BUNDLE, { text: "// nimblebrain 0.9.1\n", mode: 0o644 }),
      ["update"],
    ],
    [
      "up, with a Node that moved",
      (m: ReturnType<typeof mac>) => {
        m.deps.self = { ...m.deps.self, node: "/home/dana/.nvm/versions/node/v24.1.0/bin/node" };
      },
      ["up"],
    ],
    ["use claude again", () => {}, ["use", "claude"]],
  ] as const)(
    "%s: waits for it, then starts the new one on the same port",
    async (_, change, argv) => {
      const m = await draining();
      change(m);
      const { body, code } = await json([...argv], m);
      expect(code).toBe(0);
      expect(body.port_moved).toBeUndefined();
      expect(m.now).toBeGreaterThanOrEqual(3_000);
      expect(m.spawned.length).toBe(2);
      expect(m.spawned.at(-1)?.line).toContain("--port 27290 ");
      expect(m.loaded.has(LABEL)).toBe(true);
      expect(m.files.has(PLIST)).toBe(true);
      expect(body.agent_runtime.worker).toMatchObject({ running: true, login_item: PLIST });
      expect(envOf(m)).toContain("NB_AGENT_RUNTIME_URL=http://host.docker.internal:27290/acp\n");
    },
  );

  test.each([
    ["update", "NimbleBrain was updated, but "],
    ["up", "NimbleBrain is running, but "],
  ] as const)(
    "%s with the port held by something else after the wait is PORT_IN_USE, and puts the login item back",
    async (command, lead) => {
      const m = await draining({ tags: ["v0.73.0", "v0.74.0"] });
      const before = { plist: plistOf(m), record: m.files.get(RECORD)?.text };
      // A newer CLI file, so the item is replaced; another program takes 27290 once the worker lets go.
      m.files.set(BUNDLE, { text: "// nimblebrain 0.9.1\n", mode: 0o644 });
      m.deps.portFree = async (port) => port !== 27290;
      const { body, code } = await json([command], m);
      expect(code).toBe(1);
      expect(body).toMatchObject({ ok: false, error: "PORT_IN_USE", login_item: PLIST });
      expect(body.message).toStartWith(`${lead}port 27290 on 127.0.0.1 is in use`);
      expect(body.message).toContain("login item is back as it was");
      expect(body.fix).toBe(FIX_VARIANTS.PORT_IN_USE.worker);
      expect(body.fix).toContain("`npx nimblebrain up`");
      // The item, its record and the copy it runs are as they were, and launchd has it loaded.
      expect(plistOf(m)).toBe(before.plist);
      expect(m.files.get(RECORD)?.text).toBe(before.record);
      expect(m.files.get(BIN)?.text).toBe("// nimblebrain 0.9.0\n");
      expect(m.loaded.has(LABEL)).toBe(true);
      expect(envOf(m)).toContain("NB_AGENT_RUNTIME=claude-code\n");
    },
  );

  test("use with a busy --port puts the running worker back, and .env still dials it", async () => {
    const m = await draining({ busyPorts: [28000] });
    const before = plistOf(m);
    const { body } = await json(["use", "claude", "--port", "28000"], m);
    expect(body).toMatchObject({ error: "PORT_IN_USE", login_item: PLIST });
    expect(body.message).toContain("28000");
    expect(plistOf(m)).toBe(before);
    expect(m.loaded.has(LABEL)).toBe(true);
    expect(m.spawned.at(-1)?.line).toContain("--port 27290 ");
    expect(envOf(m)).toContain("NB_AGENT_RUNTIME_URL=http://host.docker.internal:27290/acp\n");
  });
});

describe("the turn model", () => {
  test("claude runs on Sonnet by default; --model opus is recorded, passed to the worker and reported", async () => {
    const m = mac();
    const { body } = await json(["use", "claude", "--model", "opus"], m);
    expect(body.model_source).toEqual({
      source: "claude",
      label: "your Claude Max subscription through Claude Code (Opus)",
      model: "opus",
    });
    expect(m.spawned[0]?.line).toContain("--port 27290 --model opus --log");
    expect(envOf(m)).toContain("NB_AGENT_WORKER_MODEL=opus\n");
    expect(JSON.parse(m.files.get(RECORD)?.text ?? "{}").model).toBe("opus");
  });

  test("a full model id passes through as it is", async () => {
    const m = mac();
    const { body } = await json(["use", "claude", "--model", "claude-sonnet-4-5[1m]"], m);
    expect(body.model_source.label).toBe(
      "your Claude Max subscription through Claude Code (claude-sonnet-4-5[1m])",
    );
    expect(m.spawned[0]?.line).toContain("--model claude-sonnet-4-5[1m]");
  });

  test("codex keeps Codex's own default unless one is named", async () => {
    const m = mac();
    const { body } = await json(["use", "codex"], m);
    expect(body.model_source).toMatchObject({ source: "codex", model: null });
    expect(m.spawned[0]?.line).not.toContain("--model");
    const named = mac();
    await json(["use", "codex", "--model", "gpt-x"], named);
    expect(named.spawned[0]?.line).toContain("--model gpt-x");
  });

  test("down then up starts the worker on the same model, from .env", async () => {
    const m = mac();
    await json(["use", "claude", "--model", "haiku"], m);
    await json(["down"], m);
    expect(m.files.has(RECORD)).toBe(false);
    await json(["up"], m);
    expect(m.spawned.at(-1)?.line).toContain("--model haiku");
    expect((await json(["status"], m)).body.model_source.model).toBe("haiku");
  });

  test("use api or local empties it", async () => {
    const m = mac();
    await json(["use", "claude", "--model", "opus"], m);
    await json(["use", "api"], m);
    expect(envOf(m)).toContain("NB_AGENT_WORKER_MODEL=\n");
  });

  test("init --use claude takes --model too", async () => {
    const m = mac({ files: { [`${HOME}/install.json`]: record({ phase: "starting" }) } });
    const { body } = await json(
      ["--yes", "--use", "claude", "--model", "opus", "--agent", "none"],
      m,
    );
    expect(body.model_source.model).toBe("opus");
    expect(m.spawned[0]?.line).toContain("--model opus");
  });

  test("--model with another source, or a name it cannot be, is a usage error before anything changes", async () => {
    for (const argv of [
      ["use", "api", "--model", "opus"],
      ["use", "local", "--model", "opus"],
      ["use", "claude", "--model", "two words"],
      ["--yes", "--model", "opus"],
      ["--yes", "--use", "api", "--model", "opus"],
    ]) {
      const m = mac();
      const { body, code } = await json(argv, m);
      expect(code).toBe(2);
      expect(body.error).toBe("USAGE");
      expect(m.spawned).toEqual([]);
    }
  });
});
