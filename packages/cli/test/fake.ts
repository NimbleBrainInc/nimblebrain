// The repo's own Compose file stands in for any release's: the fake serves it from raw.githubusercontent.
import repoCompose from "../../../docker-compose.yml" with { type: "text" };
import type { Deps, ExecResult } from "../src/deps.ts";

export const REPO_COMPOSE: string = repoCompose;

/** A release's Compose file that passes a local model through, as releases with `providers.local` do. */
export const LOCAL_COMPOSE: string = REPO_COMPOSE.includes("NB_LOCAL_MODEL_URL")
  ? REPO_COMPOSE
  : REPO_COMPOSE.replace(
      "      - DO_NOT_TRACK=${DO_NOT_TRACK:-}\n",
      "      - DO_NOT_TRACK=${DO_NOT_TRACK:-}\n      - NB_LOCAL_MODEL_URL=${NB_LOCAL_MODEL_URL:-}\n      - NB_LOCAL_MODEL=${NB_LOCAL_MODEL:-}\n      - NB_LOCAL_MODEL_CONTEXT=${NB_LOCAL_MODEL_CONTEXT:-}\n",
    );

/** A model as Ollama's `/api/show` describes it. */
export interface OllamaModel {
  capabilities: string[];
  /** `/api/show`'s parameters text, e.g. `num_ctx 32768`. */
  parameters?: string;
}

export interface FakeOllama {
  /** Models already on the machine, by name. */
  models?: Record<string, OllamaModel>;
  /** Models `/api/pull` can download, by name. */
  library?: Record<string, OllamaModel>;
  /**
   * Installed but not running: `until-started` answers once one of the start
   * commands (`OLLAMA_STARTS`) runs; `stays` never answers.
   */
  down?: "until-started" | "stays";
}

/** The commands that start an installed Ollama, by how it was installed. */
export const OLLAMA_STARTS = [
  "open -g -a Ollama",
  "brew services start ollama",
  "systemctl start --no-ask-password ollama",
];

/** A project as `newProject` names one: the folder's name and six hex digits. */
export const PROJECT = /^nimblebrain(-[a-z0-9_-]+)?-[0-9a-f]{6}$/;

/**
 * An install's record, `install.json`, as `init` writes it: `starting` at the
 * claim, `ready` once the first start answered health. A `starting` record
 * beside a `.env` is a home whose first start did not finish.
 */
export function record(
  over: { project?: string; port?: number; version?: string; phase?: "starting" | "ready" } = {},
): string {
  return JSON.stringify({
    project: "nimblebrain-local-0a1b2c",
    port: 27246,
    version: "0.73.0",
    phase: "ready",
    ...over,
  });
}

/** `claude auth status --json` for a person signed in to a Claude Max subscription. */
export const CLAUDE_MAX = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  subscriptionType: "max",
});

export const GB = 1024 ** 3;
export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", missing: false });
export const missing = (): ExecResult => ({ code: null, stdout: "", stderr: "", missing: true });
export const fail = (stderr = "", code = 1): ExecResult => ({
  code,
  stdout: "",
  stderr,
  missing: false,
});

export interface Machine {
  deps: Deps;
  /** Files written, by path, with the mode they were written with. */
  files: Map<string, { text: string; mode: number }>;
  /** Every program run, as one line: `<cwd>$ cmd args…`. */
  calls: string[];
  /** Every program `launch` started (a browser opener), as one line: `cmd args…`. */
  launched: string[];
  /** The environment each `docker compose` call got. */
  composeEnvs: NodeJS.ProcessEnv[];
  /** The environment each program run with one got, by its command line. */
  execEnvs: Array<{ line: string; env: NodeJS.ProcessEnv }>;
  said: string[];
  /** Each question the CLI put to the person, in order. */
  asked: string[];
  /** Whether the instance answers health; `docker compose up` turns it on, `down` off. */
  healthy: boolean;
  /** Every JSON POST, by URL: the runtime's tool calls and telemetry sent to PostHog. */
  posts: Array<{ url: string; body: unknown }>;
  /** The runtime's telemetry answer, read from `.env` when it starts, as the real one does. */
  runtimeConsent: "on" | "off" | "undecided";
  /** Agent workers running, by pid: the port each listens on, its command line, and its login item's label. */
  workers: Map<number, { port: number; command: string; label?: string }>;
  /** Every worker launchd started from a login item, as its command line (`node script args…`) and log. */
  spawned: Array<{ line: string; logPath: string }>;
  /** Login items loaded into launchd, by label; a pid while its worker runs, else its last exit code. */
  loaded: Map<string, { pid?: number; lastExit?: number }>;
  /** The servers registered in Claude Code and Codex, by name: `mcp add` adds one, `mcp remove` removes it. */
  servers: { claude: Set<string>; codex: Set<string> };
  /** Milliseconds passed, as `sleep` counts them. */
  now: number;
  /** Ports a stopped worker still holds while it drains, until the time each is let go. */
  draining: Map<number, number>;
  /** Ollama's models after the run, by name. */
  ollamaModels: Record<string, OllamaModel>;
  /** Whether Ollama answers. */
  ollamaUp: boolean;
}

export interface MachineOptions {
  /** Exact command lines (`cmd args…`) and what they answer; anything unlisted succeeds empty. */
  exec?: Record<string, ExecResult>;
  answers?: string[];
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
  portFree?: boolean;
  /** Ports something already holds; every other port is free (unless `portFree` is false). */
  busyPorts?: number[];
  /** Ports where a NimbleBrain web UI answers `/` (its page title names it). */
  nimblebrainAt?: number[];
  /** Servers already registered in Claude Code and Codex, by name. */
  servers?: { claude?: string[]; codex?: string[] };
  /** Override for the instance's answers to `/v1/*`. */
  workspaces?: Array<{ id: string; name: string }>;
  tags?: string[];
  /** What a release tag's `docker-compose.yml` answers; default the repo's file with 200. */
  compose?: { status: number; body: string } | null;
  /**
   * How the instance answers a workspace tool call (`/v1/workspaces/<wsId>/tools/call`),
   * given the workspace id and the call; undefined is a connection failure.
   */
  workspaceToolCall?: (
    wsId: string,
    call: { server: string; tool: string; arguments: Record<string, unknown> },
  ) => { status: number; body: unknown } | undefined;
  /** Ollama on `127.0.0.1:11434`; absent, nothing answers there. */
  ollama?: FakeOllama;
  /** What `launch` answers: whether the browser opener started; default true. */
  launch?: boolean;
  /** Default `linux`. */
  platform?: NodeJS.Platform;
  /** Programs on `PATH` (`which`); default none. */
  programs?: string[];
  /**
   * What an agent worker does once started: `listens` (default) answers health
   * on its port; `refuses` writes why to its log and exits, as one that is not
   * signed in does.
   */
  worker?: "listens" | "refuses";
  /** Agent workers already running when the run starts, by pid. */
  workers?: Record<number, { port: number; command: string }>;
  /**
   * How long a worker that launchd stops (`bootout`) keeps holding its port
   * while it drains, in the milliseconds `sleep` passes; default 0, released at once.
   */
  drainMs?: number;
  /** The CLI's npm `latest`; absent, the registry does not answer. */
  npmLatest?: string;
}

/**
 * A machine with Docker, Compose v2, 8 GB, an x86_64 host and a free port,
 * whose NimbleBrain becomes healthy once `docker compose up` runs. Tests
 * override the one answer they are about.
 */
export function machine(opts: MachineOptions = {}): Machine {
  const answers = [...(opts.answers ?? [])];
  const state = {
    files: new Map(Object.entries(opts.files ?? {}).map(([p, text]) => [p, { text, mode: 0o644 }])),
    calls: [] as string[],
    launched: [] as string[],
    composeEnvs: [] as NodeJS.ProcessEnv[],
    execEnvs: [] as Array<{ line: string; env: NodeJS.ProcessEnv }>,
    said: [] as string[],
    asked: [] as string[],
    healthy: false,
    posts: [] as Array<{ url: string; body: unknown }>,
    runtimeConsent: "undecided" as "on" | "off" | "undecided",
    ollamaModels: { ...(opts.ollama?.models ?? {}) } as Record<string, OllamaModel>,
    workers: new Map<number, { port: number; command: string; label?: string }>(
      Object.entries(opts.workers ?? {}).map(([pid, w]) => [Number(pid), w] as const),
    ),
    spawned: [] as Array<{ line: string; logPath: string }>,
    loaded: new Map<string, { pid?: number; lastExit?: number }>(),
    now: 0,
    draining: new Map<number, number>(),
    ollamaUp: Boolean(opts.ollama && !opts.ollama.down),
    servers: {
      claude: new Set(opts.servers?.claude ?? []),
      codex: new Set(opts.servers?.codex ?? []),
    },
  };
  const m = state;
  const exec: Record<string, ExecResult> = {
    "docker --version": ok("Docker version 27.1.1"),
    "docker info --format {{json .}}": ok(
      JSON.stringify({ Architecture: "x86_64", MemTotal: 8 * GB }),
    ),
    "docker compose version --short": ok("2.29.1"),
    // No Homebrew unless a test gives it.
    "brew list --versions ollama": missing(),
    ...opts.exec,
  };
  const deps: Deps = {
    async exec(cmd, args, o = {}) {
      const line = [cmd, ...args].join(" ");
      m.calls.push(`${o.cwd ?? ""}$ ${line}`);
      // The standalone `docker-compose` is the same program as the plugin; it drives the same instance.
      const composeLine = line.replace(/^docker-compose /, "docker compose ");
      if (composeLine.startsWith("docker compose ") && o.env) m.composeEnvs.push(o.env);
      if (o.env) m.execEnvs.push({ line, env: o.env });
      const res = exec[line] ?? workerCommand(args, line) ?? ok();
      if (res.code === 0 && composeLine.startsWith("docker compose up")) {
        m.healthy = true;
        if (m.runtimeConsent === "undecided") {
          const env = m.files.get(`${o.cwd}/.env`)?.text ?? "";
          const seed = env.match(/^NB_TELEMETRY_CONSENT=(on|off)$/m)?.[1];
          if (seed === "on" || seed === "off") m.runtimeConsent = seed;
        }
      }
      if (res.code === 0 && composeLine.startsWith("docker compose down")) m.healthy = false;
      if (
        res.code === 0 &&
        OLLAMA_STARTS.includes(line) &&
        opts.ollama &&
        opts.ollama.down !== "stays"
      )
        m.ollamaUp = true;
      // As the skills CLI does: a user-level skill lands in the agent's skills folder.
      const added = line.match(/^npx -y skills add \S+ --skill (\S+) --agent (\S+) -g/);
      if (res.code === 0 && added) {
        const dirs: Record<string, string> = {
          "claude-code": ".claude",
          codex: ".agents",
          cursor: ".cursor",
        };
        const dir = dirs[added[2] ?? ""];
        if (dir)
          m.files.set(`/home/dana/${dir}/skills/${added[1]}/SKILL.md`, { text: "", mode: 0o644 });
      }
      return res;
    },
    self: { node: "/usr/local/bin/node", script: "/home/dana/.npm/_npx/1/nimblebrain.js" },
    uid: 501,
    async launch(cmd, args) {
      m.launched.push([cmd, ...args].join(" "));
      return opts.launch ?? true;
    },
    which: async (cmd) =>
      (opts.programs ?? []).includes(cmd) ? `/opt/homebrew/bin/${cmd}` : undefined,
    portFree: async (port) =>
      (opts.portFree ?? true) &&
      !(opts.busyPorts ?? []).includes(port) &&
      (m.draining.get(port) ?? 0) <= m.now,
    async getText(url) {
      const page = url.match(/^http:\/\/127\.0\.0\.1:(\d+)\/$/);
      if (page) {
        return (opts.nimblebrainAt ?? []).includes(Number(page[1]))
          ? { status: 200, body: "<!doctype html><title>NimbleBrain</title>" }
          : undefined;
      }
      const health = url.match(/^http:\/\/127\.0\.0\.1:(\d+)\/healthz$/);
      if (health) {
        const listening = [...m.workers.values()].some((w) => w.port === Number(health[1]));
        return listening ? { status: 200, body: "ok" } : undefined;
      }
      if (url.endsWith("info/refs?service=git-upload-pack")) {
        // Git's ref advertisement: a peeled `^{}` line follows each annotated tag.
        const refs = (opts.tags ?? []).flatMap((t) => [
          `003f${"0".repeat(40)} refs/tags/${t}\n`,
          `0042${"0".repeat(40)} refs/tags/${t}^{}\n`,
        ]);
        return { status: 200, body: `001e# service=git-upload-pack\n0000${refs.join("")}0000` };
      }
      if (!url.includes("raw.githubusercontent.com")) return undefined;
      if (opts.compose === null) return undefined;
      return opts.compose ?? { status: 200, body: REPO_COMPOSE };
    },
    async getJson(url) {
      if (url.startsWith("https://registry.npmjs.org/")) {
        return opts.npmLatest ? { status: 200, body: { version: opts.npmLatest } } : undefined;
      }
      if (url.startsWith("http://127.0.0.1:11434/")) {
        if (!m.ollamaUp) return undefined;
        return url.endsWith("/api/version")
          ? { status: 200, body: { version: "0.32.5" } }
          : undefined;
      }
      if (!m.healthy) return undefined;
      if (url.endsWith("/v1/health")) return { status: 200, body: { status: "ok" } };
      if (url.endsWith("/v1/bootstrap")) {
        // As the real runtime answers: the providers the config allows, which
        // is `["anthropic"]` with no provider config, whether or not a key is set.
        return {
          status: 200,
          body: {
            workspaces: opts.workspaces ?? [{ id: "ws_1", name: "Default" }],
            config: { configuredProviders: ["anthropic"] },
          },
        };
      }
      return undefined;
    },
    async postJson(url, body) {
      m.posts.push({ url, body });
      if (url.startsWith("http://127.0.0.1:11434/")) return ollama(url, body);
      if (url.includes("posthog.com")) return { status: 200, body: { status: 1 } };
      const ws = url.match(/\/v1\/workspaces\/([^/]+)\/tools\/call$/);
      if (m.healthy && ws && opts.workspaceToolCall) {
        return opts.workspaceToolCall(
          decodeURIComponent(ws[1] ?? ""),
          body as { server: string; tool: string; arguments: Record<string, unknown> },
        );
      }
      if (!m.healthy || !url.endsWith("/v1/tools/call")) return undefined;
      const call = body as { tool: string; arguments: { consent?: "on" | "off" } };
      if (call.tool === "set_telemetry" && call.arguments.consent) {
        m.runtimeConsent = call.arguments.consent;
      }
      return {
        status: 200,
        body: { structuredContent: { telemetry: { consent: m.runtimeConsent } }, isError: false },
      };
    },
    readText: async (path) => m.files.get(path)?.text,
    // A folder exists when a file is in it.
    exists: async (path) => [...m.files.keys()].some((f) => f === path || f.startsWith(`${path}/`)),
    async writeText(path, text, mode = 0o644) {
      m.files.set(path, { text, mode });
    },
    async remove(path) {
      m.files.delete(path);
    },
    async prompt(question) {
      m.asked.push(question);
      return answers.shift() ?? "";
    },
    interactive: opts.interactive ?? false,
    sleep: async (ms) => {
      m.now += ms;
    },
    say: (line) => {
      m.said.push(line);
    },
    // No telemetry destination and no update check unless a test gives
    // them, so a test about something else is never asked the telemetry
    // question and never looks for a newer release.
    // A desktop session, so a browser can open unless a test takes the display away.
    env: {
      NIMBLEBRAIN_TELEMETRY_KEY: "",
      NIMBLEBRAIN_NO_UPDATE_CHECK: "1",
      DISPLAY: ":0",
      ...opts.env,
    },
    platform: opts.platform ?? "linux",
    home: "/home/dana",
    cwd: "/home/dana/src",
  };
  /**
   * `launchctl bootstrap | bootout | print` for this user's login items, as
   * launchd answers: a bootstrap reads the plist and starts its worker (or,
   * with `worker: "refuses"`, the worker writes why to its log and exits 1).
   */
  function launchctl(args: string[]): ExecResult | undefined {
    const [verb, target = "", plistPath] = args;
    if (verb === "bootstrap" && plistPath) {
      const text = m.files.get(plistPath)?.text ?? "";
      const label = text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
      if (m.loaded.has(label)) return fail("Bootstrap failed: 5: Input/output error", 5);
      const program = [
        ...(
          text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? ""
        ).matchAll(/<string>([^<]*)<\/string>/g),
      ].map((x) => x[1] ?? "");
      const logPath =
        text.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
      const line = program.join(" ");
      m.spawned.push({ line, logPath });
      if (opts.worker === "refuses") {
        m.files.set(logPath, {
          text: "\n  Not started: Claude Code is not signed in.\n\n",
          mode: 0o600,
        });
        m.loaded.set(label, { lastExit: 1 });
        return ok();
      }
      const pid = 4242 + m.spawned.length - 1;
      const port = Number(program[program.indexOf("--port") + 1]);
      m.workers.set(pid, { port, command: line, label });
      m.loaded.set(label, { pid });
      return ok();
    }
    const label = target.split("/").slice(2).join("/");
    if (verb === "bootout") {
      if (!m.loaded.delete(label)) return fail("Boot-out failed: 3: No such process", 3);
      for (const [pid, w] of m.workers) {
        if (w.label !== label) continue;
        m.workers.delete(pid);
        if (opts.drainMs) m.draining.set(w.port, m.now + opts.drainMs);
      }
      return ok();
    }
    if (verb === "print") {
      const l = m.loaded.get(label);
      if (!l) return fail(`Could not find service "${label}"`, 113);
      return ok(
        l.pid
          ? `${label} = {\n\tstate = running\n\tpid = ${l.pid}\n}\n`
          : `${label} = {\n\tstate = not running\n\tlast exit code = ${l.lastExit ?? 0}\n}\n`,
      );
    }
    return undefined;
  }

  /** `ps -p <pid> -o command=` and `kill`, as they answer for the agent workers running, and `launchctl`. */
  function workerCommand(args: string[], line: string): ExecResult | undefined {
    if (line.startsWith("launchctl ")) return launchctl(args);
    const mcp = line.match(/^(claude|codex) mcp (add|remove|get) /);
    if (mcp) return agentServers(mcp[1] as "claude" | "codex", mcp[2] ?? "", args);
    const ps = line.match(/^ps -p (\d+) -o command=$/);
    if (ps) {
      const w = m.workers.get(Number(ps[1]));
      return w ? ok(`${w.command}\n`) : fail("", 1);
    }
    const kill = line.match(/^kill -(TERM|KILL) (\d+)$/);
    if (kill) {
      const pid = Number(args[1]);
      return m.workers.delete(pid) ? ok() : fail("no such process");
    }
    return undefined;
  }

  /**
   * `claude mcp` and `codex mcp`, as each agent's CLI keeps its servers: `get`
   * fails for a name it does not have, `add` and `remove` change the set.
   */
  function agentServers(agent: "claude" | "codex", verb: string, args: string[]): ExecResult {
    const set = m.servers[agent];
    const name =
      verb === "add"
        ? agent === "claude"
          ? (args.at(-2) ?? "")
          : (args[2] ?? "")
        : (args.at(-1) ?? "");
    if (verb === "get")
      return set.has(name) ? ok(name) : fail(`No MCP server found with name: ${name}`);
    if (verb === "add") {
      if (set.has(name)) return fail(`MCP server ${name} already exists`);
      set.add(name);
      return ok();
    }
    return set.delete(name) ? ok() : fail(`No MCP server found with name: ${name}`);
  }

  /** Ollama's API, as the real one answers the calls the CLI makes. */
  function ollama(url: string, body: unknown): { status: number; body: unknown } | undefined {
    if (!opts.ollama || !m.ollamaUp) return undefined;
    const req = body as { model: string; from?: string; parameters?: { num_ctx?: number } };
    if (url.endsWith("/api/show")) {
      const found = m.ollamaModels[req.model];
      return found ? { status: 200, body: found } : { status: 404, body: { error: "not found" } };
    }
    if (url.endsWith("/api/pull")) {
      const found = opts.ollama.library?.[req.model];
      if (!found)
        return { status: 500, body: { error: "pull model manifest: file does not exist" } };
      m.ollamaModels[req.model] = found;
      return { status: 200, body: { status: "success" } };
    }
    if (url.endsWith("/api/create")) {
      const from = req.from ? m.ollamaModels[req.from] : undefined;
      if (!from) return { status: 404, body: { error: "base model not found" } };
      const ctx = req.parameters?.num_ctx;
      m.ollamaModels[req.model] = {
        capabilities: from.capabilities,
        parameters: ctx ? `num_ctx                        ${ctx}` : from.parameters,
      };
      return { status: 200, body: { status: "success" } };
    }
    return undefined;
  }

  return Object.assign(state, { deps });
}
