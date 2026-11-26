import { basename, join } from "node:path";
import type { Agent } from "./args.ts";
import { type Deps, defaultHome } from "./deps.ts";
import { otherHomes } from "./ports.ts";
import type { InstallState } from "./status.ts";

/** The name the default home's workspace server is registered under in every agent. */
export const SERVER_NAME = "nimblebrain";

/** The name this install's server is registered under: the one its record holds, else an older CLI's `nimblebrain`. */
export function serverNameOf(install: Pick<InstallState, "serverName">): string {
  return install.serverName ?? SERVER_NAME;
}

/**
 * The server name for a new install in `home`, so two installs never share
 * one registration in a coding agent: `nimblebrain` for the default home,
 * else `nimblebrain-<slug>`, the slug from the folder's name (lowercase,
 * `[a-z0-9-]`, without a leading `.` or `nimblebrain`), so
 * `~/.nimblebrain-beta` gives `nimblebrain-beta` and `~/nb-rc`
 * `nimblebrain-nb-rc`. The project (`newProject`, unique to the home) when the
 * slug is empty or another install this CLI can see has that name.
 */
export async function chooseServerName(deps: Deps, home: string, project: string): Promise<string> {
  if (home === defaultHome(deps)) return SERVER_NAME;
  const slug = basename(home)
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/^nimblebrain-?/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return project;
  const name = `${SERVER_NAME}-${slug}`;
  const taken = new Set<string>();
  for (const other of otherHomes(deps, home)) {
    const text = await deps.readText(join(other, "install.json"));
    if (text === undefined) continue;
    try {
      const r = JSON.parse(text) as { serverName?: unknown } | null;
      taken.add(typeof r?.serverName === "string" ? r.serverName : SERVER_NAME);
    } catch {
      // Not a record; it holds no name.
    }
  }
  return taken.has(name) ? project : name;
}

export interface Connection {
  connected: Agent | null;
  /** The name the server was registered under, or would have been. */
  name: string;
  /** When connecting failed, what to add by hand. */
  manual?: string;
}

/**
 * Registers the workspace's MCP URL with a coding agent, through each agent's
 * own supported way: its CLI where it has one, its config file where it does
 * not. Never fails `init`: an agent that is not installed, or refuses, gets
 * the settings to add by hand, because the instance is up and usable either way.
 *
 * Under `nimblebrain`, the default home's name, an earlier registration is
 * replaced: it is the default install's. Any other name never replaces one
 * this install did not make: when the agent already has a server by that
 * name, the install registers under `fallback` (its project) instead.
 *
 * The URL needs no credential: the local instance uses the `dev` adapter.
 */
export async function connectAgent(
  deps: Deps,
  agent: Agent,
  mcpUrl: string,
  names: { name: string; fallback: string },
): Promise<Connection> {
  let name = names.name;
  if (agent === "none") return { connected: null, name };
  try {
    if (name !== SERVER_NAME && (await registered(deps, agent, name))) name = names.fallback;
    const manual = manualSettings(agent, name, mcpUrl);
    if (agent === "claude-code") {
      // Replace rather than duplicate: a second `add` under the same name fails.
      await deps.exec("claude", ["mcp", "remove", "-s", "user", name]);
      const res = await deps.exec("claude", [
        "mcp",
        "add",
        "--transport",
        "http",
        "-s",
        "user",
        name,
        mcpUrl,
      ]);
      return res.code === 0 ? { connected: agent, name } : { connected: null, name, manual };
    }
    if (agent === "codex") {
      await deps.exec("codex", ["mcp", "remove", name]);
      const res = await deps.exec("codex", ["mcp", "add", name, "--url", mcpUrl]);
      return res.code === 0 ? { connected: agent, name } : { connected: null, name, manual };
    }
    await connectCursor(deps, name, mcpUrl);
    return { connected: agent, name };
  } catch {
    return { connected: null, name, manual: manualSettings(agent, name, mcpUrl) };
  }
}

/** Whether the agent already has a server registered under `name`. */
async function registered(deps: Deps, agent: Agent, name: string): Promise<boolean> {
  if (agent === "claude-code") return (await deps.exec("claude", ["mcp", "get", name])).code === 0;
  if (agent === "codex") return (await deps.exec("codex", ["mcp", "get", name])).code === 0;
  if (agent === "cursor") return name in ((await readCursor(deps)).mcpServers ?? {});
  return false;
}

/** Removes this install's registration, by the name it recorded; every other server stays. Best effort. */
export async function disconnectAgent(deps: Deps, agent: Agent, name: string): Promise<void> {
  if (agent === "claude-code") await deps.exec("claude", ["mcp", "remove", "-s", "user", name]);
  if (agent === "codex") await deps.exec("codex", ["mcp", "remove", name]);
  if (agent !== "cursor") return;
  try {
    const config = await readCursor(deps);
    if (!config.mcpServers || !(name in config.mcpServers)) return;
    delete config.mcpServers[name];
    await deps.writeText(cursorPath(deps), `${JSON.stringify(config, null, 2)}\n`, 0o600);
  } catch {
    // A config that does not parse is left as it is.
  }
}

const cursorPath = (deps: Deps) => join(deps.home, ".cursor", "mcp.json");

async function readCursor(deps: Deps): Promise<{ mcpServers?: Record<string, unknown> }> {
  const text = await deps.readText(cursorPath(deps));
  return text ? (JSON.parse(text) as { mcpServers?: Record<string, unknown> }) : {};
}

/** Merges the server into `~/.cursor/mcp.json`, keeping every other server there. */
async function connectCursor(deps: Deps, name: string, mcpUrl: string): Promise<void> {
  const config = await readCursor(deps);
  config.mcpServers = { ...(config.mcpServers ?? {}), [name]: { url: mcpUrl } };
  await deps.writeText(cursorPath(deps), `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

function manualSettings(agent: Agent, name: string, mcpUrl: string): string {
  if (agent === "claude-code") return `claude mcp add --transport http -s user ${name} ${mcpUrl}`;
  if (agent === "codex") return `codex mcp add ${name} --url ${mcpUrl}`;
  return `Add to ~/.cursor/mcp.json: {"mcpServers":{"${name}":{"url":"${mcpUrl}"}}}`;
}

/**
 * Installs the `nimblebrain` skill for the agent, at user level, so it knows
 * how to drive this CLI and the workspace. Best effort, like connecting.
 */
export async function installSkill(deps: Deps, agent: Agent): Promise<void> {
  if (agent === "none") return;
  await deps.exec(
    "npx",
    [
      "-y",
      "skills",
      "add",
      "nimblebraininc/skills",
      "--skill",
      SKILL_NAME,
      "--agent",
      agent,
      "-g",
      "-y",
    ],
    { timeoutMs: 120_000 },
  );
}

/** What `update` did to the agent's skill; a failure is reported, never an error. */
export type SkillRefresh = "updated" | "unchanged" | "not_installed" | "failed";

/**
 * Brings the agent's `nimblebrain` skill to the skills repo's newest, as
 * `update` brings the runtime to the newest release. Best effort, like
 * `installSkill`. A skill that is not there is left out: `status` says how
 * to add it, and a person who removed it meant to. The skills CLI exits
 * non-zero on a failure and prints `Updated <n> skill(s)` when it changed one.
 */
export async function refreshSkill(deps: Deps, agent: Agent): Promise<SkillRefresh> {
  if (!(await skillInstalled(deps, agent))) return "not_installed";
  try {
    const res = await deps.exec("npx", ["-y", "skills", "update", SKILL_NAME, "-g", "-y"], {
      timeoutMs: 120_000,
    });
    if (res.code !== 0) return "failed";
    return /Updated \d+ skill/.test(res.stdout) ? "updated" : "unchanged";
  } catch {
    return "failed";
  }
}

/** The skill `init` installs, by the name the skills CLI installs it under. */
export const SKILL_NAME = "nimblebrain";

/**
 * Where the skills CLI (`npx skills add -g`) puts a user-level skill for each
 * agent: the same folders it uses, so a skill added by hand counts too.
 */
function globalSkillsDir(deps: Deps, agent: Agent): string | undefined {
  if (agent === "claude-code")
    return join(deps.env.CLAUDE_CONFIG_DIR?.trim() || join(deps.home, ".claude"), "skills");
  if (agent === "codex") return join(deps.home, ".agents", "skills");
  if (agent === "cursor") return join(deps.home, ".cursor", "skills");
  return undefined;
}

/**
 * Whether the agent has the skill now, read from its skills folder rather than
 * from what `init` recorded: a skill added or removed later is seen as it is.
 */
export async function skillInstalled(deps: Deps, agent: Agent): Promise<string | null> {
  const dir = globalSkillsDir(deps, agent);
  if (!dir) return null;
  return (await deps.readText(join(dir, SKILL_NAME, "SKILL.md"))) === undefined ? null : SKILL_NAME;
}
