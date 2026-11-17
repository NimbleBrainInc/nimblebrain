import type { Deps, ExecResult } from "../src/deps.ts";

export const GB = 1024 ** 3;
export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", missing: false });
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
  /** The environment each `docker compose` call got. */
  composeEnvs: NodeJS.ProcessEnv[];
  said: string[];
  /** Whether the instance answers health; `docker compose up` turns it on, `down` off. */
  healthy: boolean;
  /** Every JSON POST, by URL: the runtime's tool calls and telemetry sent to PostHog. */
  posts: Array<{ url: string; body: unknown }>;
  /** The runtime's telemetry answer, read from `.env` when it starts, as the real one does. */
  runtimeConsent: "on" | "off" | "undecided";
}

export interface MachineOptions {
  /** Exact command lines (`cmd args…`) and what they answer; anything unlisted succeeds empty. */
  exec?: Record<string, ExecResult>;
  answers?: string[];
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
  portFree?: boolean;
  /** Override for the instance's answers to `/v1/*`. */
  workspaces?: Array<{ id: string; name: string }>;
  tags?: string[];
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
    composeEnvs: [] as NodeJS.ProcessEnv[],
    said: [] as string[],
    healthy: false,
    posts: [] as Array<{ url: string; body: unknown }>,
    runtimeConsent: "undecided" as "on" | "off" | "undecided",
  };
  const m = state;
  const exec: Record<string, ExecResult> = {
    "docker --version": ok("Docker version 27.1.1"),
    "docker info --format {{json .}}": ok(
      JSON.stringify({ Architecture: "x86_64", MemTotal: 8 * GB }),
    ),
    "docker compose version --short": ok("2.29.1"),
    "docker compose ls -a --format json": ok("[]"),
    ...opts.exec,
  };
  const deps: Deps = {
    async exec(cmd, args, o = {}) {
      const line = [cmd, ...args].join(" ");
      m.calls.push(`${o.cwd ?? ""}$ ${line}`);
      if (cmd === "docker" && args[0] === "compose" && o.env) m.composeEnvs.push(o.env);
      const res = exec[line] ?? ok();
      if (res.code === 0 && line.startsWith("docker compose up")) {
        m.healthy = true;
        if (m.runtimeConsent === "undecided") {
          const env = m.files.get(`${o.cwd}/.env`)?.text ?? "";
          const seed = env.match(/^NB_TELEMETRY_CONSENT=(on|off)$/m)?.[1];
          if (seed === "on" || seed === "off") m.runtimeConsent = seed;
        }
      }
      if (res.code === 0 && line.startsWith("docker compose down")) m.healthy = false;
      return res;
    },
    portFree: async () => opts.portFree ?? true,
    async getJson(url) {
      if (url.includes("api.github.com"))
        return { status: 200, body: (opts.tags ?? []).map((name) => ({ name })) };
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
      if (url.includes("posthog.com")) return { status: 200, body: { status: 1 } };
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
    async writeText(path, text, mode = 0o644) {
      m.files.set(path, { text, mode });
    },
    async remove(path) {
      m.files.delete(path);
    },
    async prompt() {
      return answers.shift() ?? "";
    },
    interactive: opts.interactive ?? false,
    sleep: async () => {},
    say: (line) => {
      m.said.push(line);
    },
    env: opts.env ?? {},
    home: "/home/dana",
  };
  return Object.assign(state, { deps });
}
