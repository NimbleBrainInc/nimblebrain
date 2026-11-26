import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import type { Deps, ExecOptions, ExecResult } from "./deps.ts";
import { CliError, type FixVariant } from "./result.ts";

/**
 * The Compose project for a new install in `home`: the folder's name, for a
 * person reading `docker ps`, and six random hex digits, so no two homes share
 * one, whatever their folders are called (`~/nb-rc` gives
 * `nimblebrain-nb-rc-3f9a1c`). The project names the containers, the network
 * and the data volume. `init` chooses it once, at the claim, and records it in
 * `install.json`; every later command reads it from there, so moving the
 * folder changes nothing. Always a valid Compose name: lowercase, starting
 * with a letter.
 */
export function newProject(home: string): string {
  const slug = basename(home)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  const name = !slug
    ? "nimblebrain"
    : slug.startsWith("nimblebrain")
      ? slug
      : `nimblebrain-${slug}`;
  return `${name}-${randomBytes(3).toString("hex")}`;
}

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

/**
 * Whether the runtime of this Compose file can reach a server on this machine:
 * its file maps the host and sets `NB_HOST_LOOPBACK` (ADR-0065). An install on
 * an older release gets it through `update`.
 */
export function hostLoopback(composeText: string): boolean {
  return composeText.includes("NB_HOST_LOOPBACK");
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

/** How to run Compose v2 on this machine, and its version. */
export interface ComposeProgram {
  cmd: string;
  args: string[];
  version: string;
}

const PLUGIN = { cmd: "docker", args: ["compose"] };

/** One lookup per run: every Compose call in it runs the same program. */
const found = new WeakMap<Deps, Promise<ComposeProgram | undefined>>();

/**
 * Compose v2 as Docker's plugin (`docker compose`), else as the standalone
 * `docker-compose` v2, which is the same program (Homebrew installs it that
 * way, as on a Colima machine, and Docker finds it only once it is linked into
 * a plugin folder). Undefined when neither is v2; `doctor` reports that as
 * `COMPOSE_MISSING`. Compose v1 is a different program and is never used.
 */
export function findCompose(deps: Deps): Promise<ComposeProgram | undefined> {
  let lookup = found.get(deps);
  if (!lookup) {
    lookup = lookUpCompose(deps);
    found.set(deps, lookup);
  }
  return lookup;
}

async function lookUpCompose(deps: Deps): Promise<ComposeProgram | undefined> {
  for (const program of [PLUGIN, { cmd: "docker-compose", args: [] }]) {
    const res = await deps.exec(program.cmd, [...program.args, "version", "--short"]);
    if (res.code === 0 && majorOf(res.stdout) >= 2)
      return { ...program, version: res.stdout.trim() };
  }
  return undefined;
}

/** The major version in `2.29.1` or `v2.29.1`; NaN when there is none. */
export function majorOf(version: string): number {
  return Number.parseInt(version.trim().replace(/^v/, ""), 10);
}

/** Runs a Compose subcommand with the program `findCompose` chose, else the plugin, whose failure then says why. */
export async function composeExec(
  deps: Deps,
  args: string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  const program = (await findCompose(deps)) ?? PLUGIN;
  return deps.exec(program.cmd, [...program.args, ...args], opts);
}

/** Runs Compose in the install folder, with the key variables of its installed Compose file withheld. */
export async function compose(
  deps: Deps,
  home: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<ExecResult> {
  const vars = keyVars((await deps.readText(paths(home).compose)) ?? "");
  return composeExec(deps, args, {
    cwd: home,
    env: composeEnv(deps, vars),
    timeoutMs,
  });
}

/**
 * Whether the claim wrote every install file. `.env` is written last, and
 * nothing is started before it exists, so without it this home has no
 * containers, and Compose must not run here: with no `COMPOSE_PROJECT_NAME`
 * it would name the project after the folder, which may be another install's.
 */
export async function claimWritten(deps: Deps, home: string): Promise<boolean> {
  return (await deps.readText(paths(home).env)) !== undefined;
}

/**
 * Whether this home's own containers are running (`compose ps -q` lists any).
 * The port they publish is then this install's, not something in the way.
 */
export async function runningHere(deps: Deps, home: string): Promise<boolean> {
  if (!(await claimWritten(deps, home))) return false;
  const res = await compose(deps, home, ["ps", "-q"], 30_000);
  return res.code === 0 && res.stdout.trim() !== "";
}

/**
 * The fix for a stopped Docker, by the socket Docker names: Colima's default VM
 * starts with `colima start`; another profile starts by its own name, so it
 * keeps the general fix.
 */
export function daemonVariant(text: string): FixVariant | undefined {
  return /\/\.colima\/default\//.test(text) ? "colima" : undefined;
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
  // Before the network check: a stale socket answers "connection refused".
  if (/cannot connect to the docker daemon|failed to connect to the docker api/i.test(text)) {
    return new CliError("DOCKER_NOT_RUNNING", last, {}, daemonVariant(text));
  }
  if (/no such host|timeout|TLS handshake|connection refused|network is unreachable/i.test(text)) {
    return new CliError("NETWORK", last);
  }
  if (/port is already allocated|address already in use/i.test(text)) {
    return new CliError("PORT_IN_USE", last);
  }
  // Docker Desktop names the cause itself: the folder is not in its file sharing list.
  if (/is not shared from the host/i.test(text)) {
    return new CliError("HOME_NOT_SHARED", last);
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

/** The provider whose key `.env` sets, by the names `providers` gives; null when none is set. */
export function keyProvider(envText: string, composeText: string): string | null {
  const set = Object.entries(providers(composeText)).find(([, v]) => hasKey(envText, [v]));
  return set ? set[0] : null;
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
