import { join } from "node:path";
import type { Agent } from "./args.ts";
import type { Deps } from "./deps.ts";

/** The name the workspace's server is registered under in every agent. */
export const SERVER_NAME = "nimblebrain";

export interface Connection {
  connected: Agent | null;
  /** When connecting failed, what to add by hand. */
  manual?: string;
}

/**
 * Registers the workspace's MCP URL with a coding agent, through each agent's
 * own supported way: its CLI where it has one, its config file where it does
 * not. Never fails `init`: an agent that is not installed, or refuses, gets
 * the settings to add by hand, because the instance is up and usable either way.
 *
 * The URL needs no credential: the local instance uses the `dev` adapter.
 */
export async function connectAgent(deps: Deps, agent: Agent, mcpUrl: string): Promise<Connection> {
  if (agent === "none") return { connected: null };
  const manual = manualSettings(agent, mcpUrl);
  try {
    if (agent === "claude-code") {
      // Replace rather than duplicate: a second `add` under the same name fails.
      await deps.exec("claude", ["mcp", "remove", "-s", "user", SERVER_NAME]);
      const res = await deps.exec("claude", [
        "mcp",
        "add",
        "--transport",
        "http",
        "-s",
        "user",
        SERVER_NAME,
        mcpUrl,
      ]);
      return res.code === 0 ? { connected: agent } : { connected: null, manual };
    }
    if (agent === "codex") {
      await deps.exec("codex", ["mcp", "remove", SERVER_NAME]);
      const res = await deps.exec("codex", ["mcp", "add", SERVER_NAME, "--url", mcpUrl]);
      return res.code === 0 ? { connected: agent } : { connected: null, manual };
    }
    await connectCursor(deps, mcpUrl);
    return { connected: agent };
  } catch {
    return { connected: null, manual };
  }
}

/** Merges the server into `~/.cursor/mcp.json`, keeping every other server there. */
async function connectCursor(deps: Deps, mcpUrl: string): Promise<void> {
  const path = join(deps.home, ".cursor", "mcp.json");
  const text = await deps.readText(path);
  const config = text ? (JSON.parse(text) as { mcpServers?: Record<string, unknown> }) : {};
  config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: { url: mcpUrl } };
  await deps.writeText(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

function manualSettings(agent: Agent, mcpUrl: string): string {
  if (agent === "claude-code")
    return `claude mcp add --transport http -s user ${SERVER_NAME} ${mcpUrl}`;
  if (agent === "codex") return `codex mcp add ${SERVER_NAME} --url ${mcpUrl}`;
  return `Add to ~/.cursor/mcp.json: {"mcpServers":{"${SERVER_NAME}":{"url":"${mcpUrl}"}}}`;
}

/**
 * Installs the `nimblebrain` skill for the agent, at user level, so it knows
 * how to drive this CLI and the workspace. Best effort, like connecting.
 */
export async function installSkill(deps: Deps, agent: Agent): Promise<string | null> {
  if (agent === "none") return null;
  const res = await deps.exec(
    "npx",
    [
      "-y",
      "skills",
      "add",
      "nimblebraininc/skills",
      "--skill",
      "nimblebrain",
      "--agent",
      agent,
      "-g",
      "-y",
    ],
    { timeoutMs: 120_000 },
  );
  return res.code === 0 ? "nimblebrain" : null;
}
