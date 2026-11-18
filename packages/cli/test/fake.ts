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
}

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
  /** Each question the CLI put to the person, in order. */
  asked: string[];
  /** Whether the instance answers health; `docker compose up` turns it on, `down` off. */
  healthy: boolean;
  /** Every JSON POST, by URL: the runtime's tool calls and telemetry sent to PostHog. */
  posts: Array<{ url: string; body: unknown }>;
  /** The runtime's telemetry answer, read from `.env` when it starts, as the real one does. */
  runtimeConsent: "on" | "off" | "undecided";
  /** Ollama's models after the run, by name. */
  ollamaModels: Record<string, OllamaModel>;
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
    asked: [] as string[],
    healthy: false,
    posts: [] as Array<{ url: string; body: unknown }>,
    runtimeConsent: "undecided" as "on" | "off" | "undecided",
    ollamaModels: { ...(opts.ollama?.models ?? {}) } as Record<string, OllamaModel>,
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
    portFree: async () => opts.portFree ?? true,
    async getText(url) {
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
      if (url.startsWith("http://127.0.0.1:11434/")) {
        if (!opts.ollama) return undefined;
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
    sleep: async () => {},
    say: (line) => {
      m.said.push(line);
    },
    // No telemetry destination unless a test gives one, so a test about
    // something else is never asked the telemetry question.
    env: { NIMBLEBRAIN_TELEMETRY_KEY: "", ...opts.env },
    home: "/home/dana",
    cwd: "/home/dana/src",
  };
  /** Ollama's API, as the real one answers the calls the CLI makes. */
  function ollama(url: string, body: unknown): { status: number; body: unknown } | undefined {
    if (!opts.ollama) return undefined;
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
