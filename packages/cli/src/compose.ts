import { basename, join } from "node:path";
import type { Deps, ExecResult } from "./deps.ts";
import { CliError } from "./result.ts";

/**
 * The Compose project of the default home, and of every install an older CLI
 * made, whatever its home.
 */
export const DEFAULT_PROJECT = "nimblebrain-local";

/**
 * The Compose project for a new install in `home`. The project names the
 * containers, the network and the data volume (`volumeOf`), and it is how the
 * CLI tells its own install from anyone else's. It follows the home folder's
 * name, so another home is another install: `~/.nimblebrain-local` gives
 * `nimblebrain-local`, `~/nb-rc` gives `nimblebrain-nb-rc`. `init` chooses it
 * once and writes it to `install.json` and `.env`; every later command reads
 * it from there, so moving the folder changes nothing. Two homes whose folders
 * share a name share a project, which `init` refuses as `NOT_OURS`.
 */
export function projectFor(home: string): string {
  const slug = basename(home)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (!slug) return "nimblebrain";
  return slug.startsWith("nimblebrain") ? slug : `nimblebrain-${slug}`;
}

/** The project's data volume, as Compose names it. */
export const volumeOf = (project: string) => `${project}_workspace`;

const RAW = "https://raw.githubusercontent.com/NimbleBrainInc/nimblebrain";

/**
 * The chosen runtime release's own `docker-compose.yml`, from its tag, so the
 * file always matches the images it runs (ADR-0064). Never restated here. A
 * file that does not take the image tag and the web port from `.env` is from a
 * runtime this CLI cannot drive.
 */
export async function fetchCompose(deps: Deps, tag: string): Promise<string> {
  const res = await deps.getText(`${RAW}/${tag}/docker-compose.yml`, 15_000);
  if (!res) throw new CliError("NETWORK", `Could not download the Compose file for ${tag}.`);
  if (res.status === 404) {
    throw new CliError("RUNTIME_UNSUPPORTED", `NimbleBrain ${tag} has no Compose file to install.`);
  }
  if (res.status !== 200) {
    throw new CliError(
      "NETWORK",
      `Downloading the Compose file for ${tag} answered ${res.status}.`,
    );
  }
  if (!res.body.includes("${NIMBLEBRAIN_TAG") || !res.body.includes("NIMBLEBRAIN_WEB_PORT")) {
    throw new CliError(
      "RUNTIME_UNSUPPORTED",
      `NimbleBrain ${tag}'s Compose file does not take its image tag and port from .env.`,
    );
  }
  return res.body;
}

/**
 * The model-key variables a Compose file passes to the runtime, read from the
 * file itself: each passed through under its own name (`X_API_KEY=${X_API_KEY`).
 * A key renamed on the way in (the telemetry key) is not a model key.
 */
export function keyVars(composeText: string): string[] {
  return [
    ...new Set(
      [...composeText.matchAll(/\b([A-Z][A-Z0-9_]*_API_KEY)=\$\{\1\b/g)].map((m) => m[1] ?? ""),
    ),
  ];
}

/**
 * Whether the runtime of this Compose file asks before sending telemetry. Only
 * such a runtime may be given the telemetry key: an older one sends by default
 * once it has a key. Its Compose file is the one that passes the answer through.
 */
export function asksConsent(composeText: string): boolean {
  return composeText.includes("NB_TELEMETRY_CONSENT");
}

/** The provider names `key` offers, each mapped to its variable. */
export function providers(composeText: string): Record<string, string> {
  return Object.fromEntries(
    keyVars(composeText).map((v) => [
      v
        .replace(/_API_KEY$/, "")
        .replace(/_GENERATIVE_AI$/, "")
        .toLowerCase(),
      v,
    ]),
  );
}

/**
 * Compose reads a variable from the shell before `.env`, so a key exported in
 * the person's shell would silently win over the one they entered with `key`,
 * and the version, port and local model this CLI pinned could be overridden
 * the same way.
 * Every Compose call runs without them, so `<home>/.env` is the one source.
 */
export function composeEnv(deps: Deps, vars: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...deps.env };
  for (const v of [
    ...vars,
    "NIMBLEBRAIN_TAG",
    "NIMBLEBRAIN_WEB_PORT",
    "COMPOSE_PROJECT_NAME",
    "NB_TELEMETRY_KEY",
    "NB_TELEMETRY_ID",
    "NB_TELEMETRY_CONSENT",
    "NB_LOCAL_MODEL_URL",
    "NB_LOCAL_MODEL",
    "NB_LOCAL_MODEL_CONTEXT",
  ]) {
    delete env[v];
  }
  return env;
}

/** Runs `docker compose` in the install folder, with the key variables of its installed Compose file withheld. */
export async function compose(
  deps: Deps,
  home: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<ExecResult> {
  const vars = keyVars((await deps.readText(paths(home).compose)) ?? "");
  return deps.exec("docker", ["compose", ...args], {
    cwd: home,
    env: composeEnv(deps, vars),
    timeoutMs,
  });
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
export function hasKey(envText: string, vars: string[]): boolean {
  return vars.some((v) => new RegExp(`^${v}=\\S`, "m").test(envText));
}

export const paths = (home: string) => ({
  compose: join(home, "docker-compose.yml"),
  env: join(home, ".env"),
  instance: join(home, "instance.json"),
  install: join(home, "install.json"),
});

/** The `dev` adapter: no sign-in, which is why the port is published on 127.0.0.1 only. */
export const INSTANCE_JSON = `${JSON.stringify({ auth: { adapter: "dev" } }, null, 2)}\n`;
