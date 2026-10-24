/**
 * The driver for Goose (`goose acp`), an agent with its own loop. Test-only:
 * it runs Goose as a child of this process, which no installation may do
 * (ADR-0056), so it serves the live parity eval and nothing in `src/`.
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
import type { AcpConnectionTarget, AcpDriver } from "../../../src/execution/acp/driver.ts";
import { historyPrompt } from "../../../src/execution/acp/transcript.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
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
}

/** Goose's (unstable) method for a session's system prompt. */
export const GOOSE_SYSTEM_PROMPT_METHOD = "_goose/unstable/session/system-prompt/set";

/** The variable this process reads Goose's provider key from, unless configured. */
export const DEFAULT_GOOSE_API_KEY_ENV = "NB_GOOSE_API_KEY";

/** The provider key variable Goose reads, by the provider half of a model string. */
const PROVIDER_KEY_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
};

/** A system PATH: enough to start a binary, nothing from this process's own PATH. */
const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface GooseDriverDeps {
  /** Where the provider key is read from. Defaults to this process's environment. */
  env?: Record<string, string | undefined>;
  /** Resolve a bare command name to a path. Defaults to `Bun.which`. */
  which?(command: string): string | null;
}

export function createGooseDriver(
  config: GooseDriverConfig,
  deps: GooseDriverDeps = {},
): AcpDriver {
  const env = deps.env ?? process.env;
  const which = deps.which ?? ((command: string) => Bun.which(command));
  return {
    id: "goose",
    // The session's extension set is the projection alone.
    toolSurface: "projection",
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
  const keyVar = PROVIDER_KEY_VARS[provider];
  if (!keyVar) throw new Error(`Goose driver has no key mapping for provider "${provider}"`);
  const keyEnv = config.apiKeyEnv ?? DEFAULT_GOOSE_API_KEY_ENV;
  const key = env[keyEnv];
  if (!key) throw new Error(`Goose needs the ${provider} key in ${keyEnv}`);
  return {
    PATH: CHILD_PATH,
    GOOSE_PROVIDER: provider,
    GOOSE_MODEL: model,
    [keyVar]: key,
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
