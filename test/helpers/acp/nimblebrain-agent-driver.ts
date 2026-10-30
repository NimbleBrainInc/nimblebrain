/**
 * A stdio connection that runs nimblebrain-agent (`nimblebrain-agent acp`) as a child
 * process, for the parity tests (the hosted one and the live eval). Test-only: no
 * installation runs an agent as its child (ADR-0056). The driver is
 * the one an installation uses (`src/execution/acp/drivers/nimblebrain-agent.ts`), with
 * no gateway: this child calls its provider with the key in its own environment.
 *
 * NimbleBrain imports nothing of nimblebrain-agent, and the connection finds the binary
 * by path, so nimblebrain-agent is a peer like any other ACP agent. The repo pins it as a dev
 * dependency, which the production image does not install, and the connection runs
 * that pinned binary unless given another.
 *
 * Each run gets a nimblebrain-agent process of its own, in a directory of its own that is
 * removed when the run ends, with an environment that names only its model and
 * one provider key. nimblebrain-agent has no tools of its own: everything it calls comes
 * from the run's tool projection.
 */

import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpConnection, AcpConnectionTarget } from "../../../src/execution/acp/driver.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import { spawnStdioAgent } from "./stdio-agent-process.ts";

export interface AgentDriverConfig {
  /**
   * nimblebrain-agent's entry: its `src/cli.ts` (run with this Bun) or a `nimblebrain-agent`
   * binary. Default: the pinned dev dependency (`PINNED_AGENT_BIN`).
   */
  command?: string;
  /** The variable holding the provider key nimblebrain-agent is given. Default: `NB_AGENT_API_KEY`. */
  apiKeyEnv?: string;
  /**
   * The model endpoint nimblebrain-agent calls in place of its provider's own (its
   * `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`), such as a gateway or a test's fake
   * provider. Default: the provider's.
   */
  modelEndpoint?: string;
}

export {
  AGENT_SESSION_META_KEY,
  AGENT_STOP_REASON_META_KEY,
  AGENT_USAGE_META_KEY,
  agentOutcome,
  encodeHistory,
} from "../../../src/execution/acp/drivers/nimblebrain-agent.ts";

export const DEFAULT_AGENT_API_KEY_ENV = "NB_AGENT_API_KEY";

const PROVIDER_KEY_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** The base URL variable nimblebrain-agent reads, by provider (its README, "Run it"). */
const PROVIDER_BASE_URL_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
};

const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The pinned dev dependency's bin link. */
export const PINNED_AGENT_BIN = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "node_modules",
  ".bin",
  "nimblebrain-agent",
);

/**
 * The entry to run: the configured command, else the pinned bin. The bin links to the
 * agent's `src/cli.ts`, whose `env bun` shebang finds no bun on the child's PATH, so the
 * link is resolved to that file and run with this Bun.
 */
export function agentCommand(config: AgentDriverConfig): string {
  return config.command ?? realpathSync(PINNED_AGENT_BIN);
}

export function agentConnection(
  config: AgentDriverConfig,
  env: Record<string, string | undefined> = process.env,
): AcpConnection {
  return {
    async open(run) {
      const childEnv = agentEnvironment(config, run, env);
      const root = await mkdtemp(join(tmpdir(), "nb-agent-"));
      try {
        const work = join(root, "work");
        await mkdir(work, { recursive: true });
        const entry = agentCommand(config);
        const [command, args] = entry.endsWith(".ts")
          ? [process.execPath, ["--no-env-file", entry, "acp"]]
          : [entry, ["acp"]];
        const connection = spawnStdioAgent({
          command,
          args,
          cwd: work,
          env: { ...childEnv, HOME: root, TMPDIR: root },
        });
        return withCleanup(connection, root);
      } catch (err) {
        await rm(root, { recursive: true, force: true });
        throw err;
      }
    },
  };
}

/** The child's environment: its model, the one provider key it needs, and its endpoint if set. */
export function agentEnvironment(
  config: AgentDriverConfig,
  run: ResolvedRun,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const provider = run.config.model.slice(0, run.config.model.indexOf(":"));
  const keyVar = PROVIDER_KEY_VARS[provider];
  if (!keyVar)
    throw new Error(`nimblebrain-agent driver has no key mapping for provider "${provider}"`);
  const keyEnv = config.apiKeyEnv ?? DEFAULT_AGENT_API_KEY_ENV;
  const key = env[keyEnv];
  if (!key) throw new Error(`nimblebrain-agent needs the ${provider} key in ${keyEnv}`);
  const baseUrlVar = PROVIDER_BASE_URL_VARS[provider];
  return {
    ...(config.modelEndpoint && baseUrlVar ? { [baseUrlVar]: config.modelEndpoint } : {}),
    PATH: CHILD_PATH,
    NB_AGENT_MODEL: run.config.model,
    [keyVar]: key,
  };
}

function withCleanup(connection: AcpConnectionTarget, root: string): AcpConnectionTarget {
  return {
    ...connection,
    async close() {
      try {
        await connection.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
