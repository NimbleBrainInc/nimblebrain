import { join } from "node:path";
// The release's own Compose file, embedded at build time, so each CLI version
// carries the file of the runtime release it installs. Never restated here.
import composeFile from "../../../docker-compose.yml" with { type: "text" };
import type { Deps, ExecResult } from "./deps.ts";
import { CliError } from "./result.ts";

export const COMPOSE_FILE: string = composeFile;

/**
 * The Compose project name. It names the containers, the network and the data
 * volume (`nimblebrain-local_workspace`), and it is how the CLI tells its own
 * install from anyone else's.
 */
export const PROJECT = "nimblebrain-local";
export const VOLUME = `${PROJECT}_workspace`;

/**
 * The model-key variables the Compose file passes to the runtime, read from the
 * file itself: each passed through under its own name (`X_API_KEY=${X_API_KEY`).
 * A key renamed on the way in (the telemetry key) is not a model key.
 */
export const KEY_VARS: string[] = [
  ...new Set(
    [...COMPOSE_FILE.matchAll(/\b([A-Z][A-Z0-9_]*_API_KEY)=\$\{\1\b/g)].map((m) => m[1] ?? ""),
  ),
];

/** The provider names `key` offers, each mapped to its variable. */
export const PROVIDERS: Record<string, string> = Object.fromEntries(
  KEY_VARS.map((v) => [
    v
      .replace(/_API_KEY$/, "")
      .replace(/_GENERATIVE_AI$/, "")
      .toLowerCase(),
    v,
  ]),
);

/**
 * Compose reads a variable from the shell before `.env`, so a key exported in
 * the person's shell would silently win over the one they entered with `key`,
 * and the version and port this CLI pinned could be overridden the same way.
 * Every Compose call runs without them, so `<home>/.env` is the one source.
 */
export function composeEnv(deps: Deps): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...deps.env };
  for (const v of [
    ...KEY_VARS,
    "NIMBLEBRAIN_TAG",
    "NIMBLEBRAIN_WEB_PORT",
    "COMPOSE_PROJECT_NAME",
    "NB_TELEMETRY_KEY",
    "NB_TELEMETRY_ID",
    "NB_TELEMETRY_CONSENT",
  ]) {
    delete env[v];
  }
  return env;
}

export function compose(
  deps: Deps,
  home: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<ExecResult> {
  return deps.exec("docker", ["compose", ...args], { cwd: home, env: composeEnv(deps), timeoutMs });
}

/** Turns a failed Compose call into the error a person can act on. */
export function startError(res: ExecResult): CliError {
  const text = `${res.stderr}\n${res.stdout}`;
  const last =
    text
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .pop() ?? "Compose failed.";
  if (/no such host|timeout|TLS handshake|connection refused|network is unreachable/i.test(text)) {
    return new CliError("NETWORK", last);
  }
  if (/port is already allocated|address already in use/i.test(text)) {
    return new CliError("PORT_IN_USE", last);
  }
  return new CliError("START_FAILED", last);
}

/** `.env` as ordered `NAME=value` lines; comments and blanks are kept as they are. */
export function setEnvLines(text: string, values: Record<string, string>): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const name = line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1];
    if (name && name in values) {
      seen.add(name);
      return `${name}=${values[name]}`;
    }
    return line;
  });
  for (const [name, value] of Object.entries(values))
    if (!seen.has(name)) out.push(`${name}=${value}`);
  return `${out.join("\n")}\n`;
}

/** Whether `.env` sets a non-empty value for any model-key variable. Reads names, never prints values. */
export function hasKey(envText: string): boolean {
  return KEY_VARS.some((v) => new RegExp(`^${v}=\\S`, "m").test(envText));
}

export const paths = (home: string) => ({
  compose: join(home, "docker-compose.yml"),
  env: join(home, ".env"),
  instance: join(home, "instance.json"),
  install: join(home, "install.json"),
});

/** The `dev` adapter: no sign-in, which is why the port is published on 127.0.0.1 only. */
export const INSTANCE_JSON = `${JSON.stringify({ auth: { adapter: "dev" } }, null, 2)}\n`;
