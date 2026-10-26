/**
 * The driver for Reflex (`reflex acp`), NimbleBrain's engine extracted as a
 * standalone ACP agent. Test-only, as Goose's is: it runs Reflex as a child of
 * this process, which no installation may do (ADR-0056), so it serves the live
 * parity eval and nothing in `src/`.
 *
 * NimbleBrain imports nothing of Reflex. The driver speaks Reflex's documented
 * session options (`reflex/session` on `session/new`: system prompt, history,
 * model, limits) and finds the binary by path, so Reflex is a peer the way
 * Goose is, not a dependency.
 *
 * Each run gets a Reflex process of its own, in a directory of its own that is
 * removed when the run ends, with an environment that names only its model and
 * one provider key. Reflex has no tools of its own: everything it calls comes
 * from the run's tool projection.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import type { AcpConnectionTarget, AcpDriver } from "../../../src/execution/acp/driver.ts";
import { userMessageToPrompt } from "../../../src/execution/acp/nimblebrain-extension.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import { spawnStdioAgent } from "./stdio-agent-process.ts";

export interface ReflexDriverConfig {
  /** Reflex's entry: its `src/cli.ts` (run with this Bun) or a `reflex` binary. */
  command: string;
  /** The variable holding the provider key Reflex is given. Default: `NB_REFLEX_API_KEY`. */
  apiKeyEnv?: string;
}

/** Reflex's session options key (its README, "Session options"). */
export const REFLEX_SESSION_META_KEY = "reflex/session";

export const DEFAULT_REFLEX_API_KEY_ENV = "NB_REFLEX_API_KEY";

const PROVIDER_KEY_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function createReflexDriver(
  config: ReflexDriverConfig,
  env: Record<string, string | undefined> = process.env,
): AcpDriver {
  return {
    id: "reflex",
    toolSurface: "projection",
    async open(run) {
      const childEnv = reflexEnvironment(config, run, env);
      const root = await mkdtemp(join(tmpdir(), "nb-reflex-"));
      try {
        const work = join(root, "work");
        await mkdir(work, { recursive: true });
        const [command, args] = config.command.endsWith(".ts")
          ? [process.execPath, ["--no-env-file", config.command, "acp"]]
          : [config.command, ["acp"]];
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
    sessionMeta(run) {
      return {
        [REFLEX_SESSION_META_KEY]: {
          system: run.system,
          history: encodeHistory(priorMessages(run)),
          model: run.config.model,
          maxIterations: run.config.maxIterations,
          maxInputTokens: run.config.maxInputTokens,
          maxOutputTokens: run.config.maxOutputTokens,
          ...(run.config.thinking ? { thinking: run.config.thinking } : {}),
        },
      };
    },
    prompt(run) {
      const latest = run.messages.at(-1);
      return latest?.role === "user" ? userMessageToPrompt(latest) : [];
    },
  };
}

/** The child's environment: its model and the one provider key it needs. */
export function reflexEnvironment(
  config: ReflexDriverConfig,
  run: ResolvedRun,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const provider = run.config.model.slice(0, run.config.model.indexOf(":"));
  const keyVar = PROVIDER_KEY_VARS[provider];
  if (!keyVar) throw new Error(`Reflex driver has no key mapping for provider "${provider}"`);
  const keyEnv = config.apiKeyEnv ?? DEFAULT_REFLEX_API_KEY_ENV;
  const key = env[keyEnv];
  if (!key) throw new Error(`Reflex needs the ${provider} key in ${keyEnv}`);
  return { PATH: CHILD_PATH, REFLEX_MODEL: run.config.model, [keyVar]: key };
}

/**
 * History in Reflex's documented encoding: JSON, with a file part's bytes as
 * `{ "__reflex_bytes": <base64> }`.
 */
export function encodeHistory(messages: LanguageModelV4Message[]): string {
  return JSON.stringify(messages, (_key, value) =>
    value instanceof Uint8Array ? { __reflex_bytes: Buffer.from(value).toString("base64") } : value,
  );
}

function priorMessages(run: ResolvedRun): LanguageModelV4Message[] {
  return run.messages.at(-1)?.role === "user" ? run.messages.slice(0, -1) : run.messages;
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
