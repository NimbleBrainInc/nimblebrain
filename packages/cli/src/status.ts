import { join } from "node:path";
import type { Agent } from "./args.ts";
import type { Deps } from "./deps.ts";
import { CliError } from "./result.ts";

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
  health: "ok" | "down";
  url: string;
  workspaces: Workspace[];
  agent: { connected: Agent | null; skill: string | null };
  model_key: "set" | "missing" | "unknown";
}

/**
 * The install's state from the outside: is it answering, which workspaces
 * does it have, and is a model key configured. Reads only what the local
 * instance serves to anyone on this machine (`/v1/health`, and `/v1/bootstrap`
 * under the `dev` adapter), so it never needs a credential.
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

  const { workspaces, modelKey } = up
    ? await readBootstrap(deps, url)
    : { workspaces: [], modelKey: "unknown" as const };

  return {
    ok: true,
    version: install.version,
    health: up ? "ok" : "down",
    url,
    workspaces,
    agent: { connected: install.agent ?? null, skill: install.skill ?? null },
    model_key: modelKey,
  };
}

/** Workspaces and whether a provider key is configured, from `/v1/bootstrap`. */
async function readBootstrap(
  deps: Deps,
  url: string,
): Promise<{ workspaces: Workspace[]; modelKey: StatusResult["model_key"] }> {
  const boot = await deps.getJson(`${url}/v1/bootstrap`);
  if (boot?.status !== 200) return { workspaces: [], modelKey: "unknown" };
  const body = boot.body as {
    workspaces?: Array<{ id?: unknown; name?: unknown }>;
    config?: { configuredProviders?: unknown };
  };
  const workspaces = (body.workspaces ?? [])
    .filter(
      (w): w is { id: string; name: string } =>
        typeof w.id === "string" && typeof w.name === "string",
    )
    .map((w) => ({ id: w.id, name: w.name, mcp: `${url}/mcp/${w.id}` }));
  const providers = body.config?.configuredProviders;
  const modelKey = Array.isArray(providers)
    ? providers.length > 0
      ? "set"
      : "missing"
    : "unknown";
  return { workspaces, modelKey };
}
