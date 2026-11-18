import { join } from "node:path";
import type { Agent } from "./args.ts";
import { hasKey, keyVars } from "./compose.ts";
import type { Deps } from "./deps.ts";
import { CliError } from "./result.ts";
import { VERSION } from "./version.ts";

/**
 * What an install records about itself, in `<home>/install.json`. Written by
 * `init` and `update`; read by everything else. Holds no secret: the model key
 * lives in `<home>/.env`, which nothing here reads.
 */
export interface InstallState {
  version: string;
  port: number;
  /** The Compose project name, which is also what marks containers and the data volume as ours. */
  project: string;
  agent?: Agent;
  skill?: string;
}

export async function readInstall(deps: Deps, home: string): Promise<InstallState | undefined> {
  const text = await deps.readText(join(home, "install.json"));
  if (text === undefined) return undefined;
  try {
    const state = JSON.parse(text) as Partial<InstallState>;
    if (
      typeof state.version !== "string" ||
      typeof state.port !== "number" ||
      typeof state.project !== "string"
    ) {
      return undefined;
    }
    return state as InstallState;
  } catch {
    return undefined;
  }
}

export interface Workspace {
  id: string;
  name: string;
  mcp: string;
}

export interface StatusResult {
  ok: true;
  version: string;
  /** This CLI's own version; `version` is the runtime's. They move independently (ADR-0064). */
  cli_version: string;
  health: "ok" | "down";
  url: string;
  workspaces: Workspace[];
  agent: { connected: Agent | null; skill: string | null };
  model_key: "set" | "missing";
}

/**
 * The install's state from the outside: is it answering, which workspaces
 * does it have, and is a model key configured. Reads only what the local
 * instance serves to anyone on this machine (`/v1/health`, and `/v1/bootstrap`
 * under the `dev` adapter), so it never needs a credential.
 *
 * Whether a model key is set is read from the install's `.env`, not from the
 * runtime: bootstrap's `configuredProviders` lists the providers the config
 * allows (`["anthropic"]` when it names none), with or without a key.
 *
 * The MCP URL is built from the port this install published, not taken from
 * bootstrap's `mcpUrl`: inside Docker the runtime's own idea of its origin can
 * be the internal one, and the web port forwards `/mcp*` to it either way.
 */
export async function status(deps: Deps, home: string): Promise<StatusResult> {
  const install = await readInstall(deps, home);
  if (!install) throw new CliError("NOT_INSTALLED", `No NimbleBrain install in ${home}.`);
  const url = `http://127.0.0.1:${install.port}`;

  const health = await deps.getJson(`${url}/v1/health`);
  const up =
    health?.status === 200 && (health.body as { status?: unknown } | undefined)?.status === "ok";

  const workspaces = up ? await readWorkspaces(deps, url) : [];
  // The install's `.env` is the only place a key can come from: every Compose
  // call runs without the shell's key variables. Read for names, never values.
  const vars = keyVars((await deps.readText(join(home, "docker-compose.yml"))) ?? "");
  const modelKey = hasKey((await deps.readText(join(home, ".env"))) ?? "", vars)
    ? "set"
    : "missing";

  return {
    ok: true,
    version: install.version,
    cli_version: VERSION,
    health: up ? "ok" : "down",
    url,
    workspaces,
    agent: { connected: install.agent ?? null, skill: install.skill ?? null },
    model_key: modelKey,
  };
}

/** The workspaces the local `dev` identity belongs to, from `/v1/bootstrap`. */
async function readWorkspaces(deps: Deps, url: string): Promise<Workspace[]> {
  const boot = await deps.getJson(`${url}/v1/bootstrap`);
  if (boot?.status !== 200) return [];
  const body = boot.body as { workspaces?: Array<{ id?: unknown; name?: unknown }> };
  return (body.workspaces ?? [])
    .filter(
      (w): w is { id: string; name: string } =>
        typeof w.id === "string" && typeof w.name === "string",
    )
    .map((w) => ({ id: w.id, name: w.name, mcp: `${url}/mcp/${w.id}` }));
}
