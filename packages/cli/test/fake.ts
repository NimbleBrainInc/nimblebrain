// The repo's own Compose file stands in for any release's: the fake serves it from raw.githubusercontent.
import repoCompose from "../../../docker-compose.yml" with { type: "text" };
import type { Deps, ExecResult } from "../src/deps.ts";

export const REPO_COMPOSE: string = repoCompose;

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
  /** What a release tag's `docker-compose.yml` answers; default the repo's file with 200. */
  compose?: { status: number; body: string } | null;
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
      if (res.code === 0 && line.startsWith("docker compose up")) m.healthy = true;
      if (res.code === 0 && line.startsWith("docker compose down")) m.healthy = false;
      return res;
    },
    portFree: async () => opts.portFree ?? true,
    async getText(url) {
      if (!url.includes("raw.githubusercontent.com")) return undefined;
      if (opts.compose === null) return undefined;
      return opts.compose ?? { status: 200, body: REPO_COMPOSE };
    },
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
