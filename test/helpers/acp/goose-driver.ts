/**
 * The driver for Goose (`goose acp`), an agent with its own loop, and a stdio
 * connection that runs it. Test-only: the connection runs Goose as a child of
 * this process, which no installation may do (ADR-0056), so both serve the
 * live parity eval and nothing in `src/`.
 *
 * Each run gets a Goose process of its own, in a directory of its own that is
 * removed when the run ends, with an environment that names only what Goose
 * needs: its provider, its model, one provider key, and paths inside that
 * directory. Nothing of this process's environment reaches it, Goose's own
 * config and keyring are not read, and its telemetry is off.
 *
 * What NimbleBrain decided reaches Goose in Goose's own terms:
 *
 *  - Tools: `_meta.enabledExtensions` names the session's whole extension set,
 *    and it is exactly the run's tool projection. Goose's built-in extensions
 *    (shell, file editing) are not started, and with the key present Goose
 *    ignores ACP's `mcpServers`, so the projection is restated there.
 *  - The system prompt: Goose's session system-prompt method, in `set` mode,
 *    which replaces Goose's own base prompt. Goose renders it as a template,
 *    so it travels inside a raw block.
 *  - The model: the run's own, split into Goose's provider and model.
 *  - History: Goose has no slot for history it did not produce, so it travels
 *    as a contained transcript ahead of the turn's message.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AcpConnection,
  AcpConnectionTarget,
  AcpDriver,
} from "../../../src/execution/acp/driver.ts";
import { historyPrompt } from "../../../src/execution/acp/transcript.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import { modelGatewayBaseURL } from "../../../src/model/registry.ts";
import { spawnStdioAgent } from "./stdio-agent-process.ts";

export interface GooseDriverConfig {
  /** The Goose binary: a path, or a name looked up on PATH. Default: `goose`. */
  command?: string;
  /**
   * Goose's approval mode. `auto` runs tools without asking; `approve` and
   * `smart_approve` send permission requests, which the runtime answers by
   * policy. Default: `auto`.
   */
  mode?: "auto" | "approve" | "smart_approve";
  /** The variable holding the provider key Goose is given. Default: `NB_GOOSE_API_KEY`. */
  apiKeyEnv?: string;
  /**
   * The installation's model gateway, by its root URL (`execution.modelGateway`):
   * Goose calls the run's provider at its path there instead of the provider,
   * and the key Goose is given is whatever the gateway takes (a run token), not
   * a provider key. Default: the provider's own endpoint.
   */
  modelGateway?: string;
}

/** Goose's (unstable) method for a session's system prompt. */
export const GOOSE_SYSTEM_PROMPT_METHOD = "_goose/unstable/session/system-prompt/set";

/** The variable this process reads Goose's provider key from, unless configured. */
export const DEFAULT_GOOSE_API_KEY_ENV = "NB_GOOSE_API_KEY";

/**
 * How Goose reaches each provider: the Goose provider that speaks its API, the
 * variable Goose reads its key from, and the variable Goose reads its host from,
 * with the host on the gateway (Goose appends the rest of each path: Anthropic's
 * `v1/messages`, Gemini's `v1beta/...`; an OpenAI-style host ending in `/v1`
 * keeps it and gets `v1/chat/completions`) or, for a provider Goose has no
 * provider of its own for, the provider's own host. Nebius and GreenPT speak the
 * OpenAI API, so they run as Goose's OpenAI provider pointed at their host.
 */
const GOOSE_PROVIDERS: Record<
  string,
  { goose: string; keyVar: string; hostVar: string; host: (gateway?: string) => string | undefined }
> = {
  anthropic: {
    goose: "anthropic",
    keyVar: "ANTHROPIC_API_KEY",
    hostVar: "ANTHROPIC_HOST",
    host: (gateway) => gateway && `${gateway}/anthropic`,
  },
  openai: {
    goose: "openai",
    keyVar: "OPENAI_API_KEY",
    hostVar: "OPENAI_HOST",
    host: (gateway) => gateway && modelGatewayBaseURL(gateway, "openai"),
  },
  google: {
    goose: "google",
    keyVar: "GOOGLE_API_KEY",
    hostVar: "GOOGLE_HOST",
    host: (gateway) => gateway && `${gateway}/google`,
  },
  xai: {
    goose: "xai",
    keyVar: "XAI_API_KEY",
    hostVar: "XAI_HOST",
    host: (gateway) => gateway && modelGatewayBaseURL(gateway, "xai"),
  },
  nebius: {
    goose: "openai",
    keyVar: "OPENAI_API_KEY",
    hostVar: "OPENAI_HOST",
    host: (gateway) =>
      gateway ? modelGatewayBaseURL(gateway, "nebius") : "https://api.tokenfactory.nebius.com/v1",
  },
  greenpt: {
    goose: "openai",
    keyVar: "OPENAI_API_KEY",
    hostVar: "OPENAI_HOST",
    host: (gateway) =>
      gateway ? modelGatewayBaseURL(gateway, "greenpt") : "https://api.greenpt.ai/v1",
  },
};

/** A system PATH: enough to start a binary, nothing from this process's own PATH. */
const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface GooseDriverDeps {
  /** Where the provider key is read from. Defaults to this process's environment. */
  env?: Record<string, string | undefined>;
  /** Resolve a bare command name to a path. Defaults to `Bun.which`. */
  which?(command: string): string | null;
}

/** What Goose takes beyond ACP: its extension set, its system prompt method, and a transcript. */
export function createGooseDriver(): AcpDriver {
  return {
    // The session's extension set is the projection alone.
    toolSurface: "projection",
    sessionMeta(_run, plan) {
      return { enabledExtensions: plan.mcpServers.map((server) => ({ type: "mcp", server })) };
    },
    async prepareSession(calls, sessionId, run) {
      await calls.request(GOOSE_SYSTEM_PROMPT_METHOD, {
        sessionId,
        mode: "set",
        text: rawTemplate(run.system),
      });
    },
    prompt: historyPrompt,
  };
}

/** Goose as a child process per run, over stdio. */
export function gooseConnection(
  config: GooseDriverConfig,
  deps: GooseDriverDeps = {},
): AcpConnection {
  const env = deps.env ?? process.env;
  const which = deps.which ?? ((command: string) => Bun.which(command));
  return {
    async open(run) {
      const command = config.command ?? "goose";
      const binary = command.includes("/") ? command : which(command);
      if (!binary) throw new Error(`Goose binary "${command}" not found`);
      const childEnv = gooseEnvironment(config, run, env);
      const root = await mkdtemp(join(tmpdir(), "nb-goose-"));
      try {
        const dirs = {
          home: join(root, "home"),
          state: join(root, "goose"),
          work: join(root, "work"),
        };
        await Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));
        const connection = spawnStdioAgent({
          command: binary,
          args: ["acp"],
          cwd: dirs.work,
          env: { ...childEnv, HOME: dirs.home, TMPDIR: dirs.home, GOOSE_PATH_ROOT: dirs.state },
        });
        return withCleanup(connection, root);
      } catch (err) {
        await rm(root, { recursive: true, force: true });
        throw err;
      }
    },
  };
}

/**
 * The child's environment, before its paths: provider, model, key, and the
 * switches that keep Goose off the keyring and telemetry. Throws when the run's
 * provider has no key Goose can read, so a misconfiguration fails the run
 * instead of reaching a provider unauthenticated.
 */
export function gooseEnvironment(
  config: GooseDriverConfig,
  run: ResolvedRun,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const separator = run.config.model.indexOf(":");
  if (separator < 0) throw new Error(`Model "${run.config.model}" names no provider`);
  const provider = run.config.model.slice(0, separator);
  const model = run.config.model.slice(separator + 1);
  const reach = GOOSE_PROVIDERS[provider];
  if (!reach) throw new Error(`Goose driver has no key mapping for provider "${provider}"`);
  const keyEnv = config.apiKeyEnv ?? DEFAULT_GOOSE_API_KEY_ENV;
  const key = env[keyEnv];
  if (!key) throw new Error(`Goose needs the ${provider} key in ${keyEnv}`);
  const gateway = config.modelGateway?.replace(/\/+$/, "");
  const host = reach.host(gateway);
  return {
    ...(host ? { [reach.hostVar]: host } : {}),
    PATH: CHILD_PATH,
    GOOSE_PROVIDER: reach.goose,
    GOOSE_MODEL: model,
    [reach.keyVar]: key,
    GOOSE_MODE: config.mode ?? "auto",
    GOOSE_MAX_TURNS: String(run.config.maxIterations),
    GOOSE_DISABLE_KEYRING: "1",
    GOOSE_TELEMETRY_OFF: "1",
  };
}

/**
 * Text Goose's template engine leaves exactly as written. A literal
 * `{% endraw %}` in the text would close the raw block, so each one is closed,
 * emitted as a string expression, and reopened.
 */
export function rawTemplate(text: string): string {
  const escaped = text.replace(
    /\{%-?\s*endraw\s*-?%\}/g,
    (tag) => `{% endraw %}{{ ${JSON.stringify(tag)} }}{% raw %}`,
  );
  return `{% raw %}${escaped}{% endraw %}`;
}

/** The connection, closing which also removes the run's directory. */
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
