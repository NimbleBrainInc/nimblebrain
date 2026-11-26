import { join } from "node:path";
import { type AgentRuntimeState, agentRuntimeState } from "./agent-worker.ts";
import { serverNameOf, skillInstalled } from "./agents.ts";
import type { Agent } from "./args.ts";
import { hasKey, hostLoopback, keyVars } from "./compose.ts";
import type { Deps } from "./deps.ts";
import { localModelOf } from "./local-model.ts";
import { CliError } from "./result.ts";
import { currentSource, type ModelSource } from "./source.ts";
import { currentTelemetry, type TelemetryField } from "./telemetry.ts";
import { VERSION } from "./version.ts";

/**
 * An install's record, `<home>/install.json`: the one mark that a home, its
 * Compose project, containers and data volume are this CLI's. `init` writes it
 * first, before any other file, so a run that stops partway never leaves files
 * without an owner; every command reads the project and port from it and never
 * derives them. Holds no secret: the model key lives in `<home>/.env`, which
 * nothing here reads.
 */
export interface InstallState {
  /** The Compose project name, chosen once at `init` and unique to this home (`newProject`). */
  project: string;
  port: number;
  version: string;
  /**
   * `starting` from the claim until the first start answers health, `ready`
   * after. A starting install can be stopped, read and removed; using it waits
   * until `init` runs again and finishes it.
   */
  phase: "starting" | "ready";
  agent?: Agent;
  /**
   * The name the workspace's server is registered under in the coding agent,
   * chosen at the claim (`chooseServerName`): `nimblebrain` for the default
   * home, `nimblebrain-<folder>` for any other. Absent in an older CLI's
   * record, which registered under `nimblebrain` (`serverNameOf`).
   */
  serverName?: string;
}

/** The home's record; undefined when there is none, or it does not parse as one. */
export async function readInstall(deps: Deps, home: string): Promise<InstallState | undefined> {
  const text = await deps.readText(join(home, "install.json"));
  if (text === undefined) return undefined;
  try {
    const state = JSON.parse(text) as Partial<InstallState> | null;
    if (
      typeof state?.version !== "string" ||
      typeof state.port !== "number" ||
      typeof state.project !== "string" ||
      (state.phase !== "starting" && state.phase !== "ready")
    ) {
      return undefined;
    }
    if (state.serverName !== undefined && typeof state.serverName !== "string")
      delete state.serverName;
    return state as InstallState;
  } catch {
    return undefined;
  }
}

/** The home's record in any phase, for the commands that stop, read or remove an install. */
export async function requireInstall(deps: Deps, home: string): Promise<InstallState> {
  const install = await readInstall(deps, home);
  if (!install) throw new CliError("NOT_INSTALLED", `No NimbleBrain install in ${home}.`);
  return install;
}

/** The home's record once its first start came up, for the commands that use the install. */
export async function requireReady(deps: Deps, home: string): Promise<InstallState> {
  const install = await requireInstall(deps, home);
  if (install.phase !== "ready") {
    throw new CliError(
      "INSTALL_INCOMPLETE",
      `The NimbleBrain install in ${home} has not finished installing.`,
    );
  }
  return install;
}

export interface Workspace {
  id: string;
  name: string;
  mcp: string;
}

export interface StatusResult {
  ok: true;
  version: string;
  /** The install's phase: `starting` until `init` finishes it, then `ready`. */
  phase: InstallState["phase"];
  /** This CLI's own version; `version` is the runtime's. They move independently (ADR-0064). */
  cli_version: string;
  health: "ok" | "down";
  url: string;
  workspaces: Workspace[];
  agent: { connected: Agent | null; server: string | null; skill: string | null };
  model_key: "set" | "missing";
  /** Whether the installed release can reach a server on this machine (`mcp add`); false until `update`. */
  host_loopback: boolean;
  /** The local model NimbleBrain's agents run on (`npx nimblebrain local-model`), or null for a hosted key. */
  local_model: string | null;
  /** What runs NimbleBrain's agents (`npx nimblebrain use`): claude, codex, api, local, or null for nothing yet. */
  model_source: ModelSource;
  /** The runtime NimbleBrain's agents run on, and its worker on this machine. */
  agent_runtime: AgentRuntimeState;
  telemetry: TelemetryField;
}

/**
 * The install's state from the outside, in any phase: is it answering, which workspaces
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
  const install = await requireInstall(deps, home);
  const url = installUrl(install);

  const up = await isUp(deps, url);

  // A starting install has no workspace to hand an agent yet: `init` finishes it first.
  const workspaces = up && install.phase === "ready" ? await readWorkspaces(deps, url) : [];
  // The install's `.env` is the only place a key can come from: every Compose
  // call runs without the shell's key variables. Read for names, never values.
  const composeText = (await deps.readText(join(home, "docker-compose.yml"))) ?? "";
  const vars = keyVars(composeText);
  const envText = (await deps.readText(join(home, ".env"))) ?? "";
  const modelKey = hasKey(envText, vars) ? "set" : "missing";

  return {
    ok: true,
    version: install.version,
    phase: install.phase,
    cli_version: VERSION,
    health: up ? "ok" : "down",
    url,
    workspaces,
    agent: {
      connected: install.agent ?? null,
      server: install.agent ? serverNameOf(install) : null,
      skill: install.agent ? await skillInstalled(deps, install.agent) : null,
    },
    model_key: modelKey,
    host_loopback: hostLoopback(composeText),
    local_model: localModelOf(envText) ?? null,
    model_source: await currentSource(deps, home),
    agent_runtime: await agentRuntimeState(deps, home),
    telemetry: await currentTelemetry(deps, home, url),
  };
}

/** Where an install's web UI and API answer: the port it published, on loopback only. */
export function installUrl(install: Pick<InstallState, "port">): string {
  return `http://127.0.0.1:${install.port}`;
}

/** Whether the instance at `url` answers health. */
export async function isUp(deps: Deps, url: string): Promise<boolean> {
  const health = await deps.getJson(`${url}/v1/health`);
  return (
    health?.status === 200 && (health.body as { status?: unknown } | undefined)?.status === "ok"
  );
}

/** The workspaces the local `dev` identity belongs to, from `/v1/bootstrap`. */
export async function readWorkspaces(deps: Deps, url: string): Promise<Workspace[]> {
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

/** Whether something runs NimbleBrain's agents: a subscription, a key, or a local model. */
export function hasModelIn(r: { model_source: { source: unknown } }): boolean {
  return r.model_source.source !== null;
}
