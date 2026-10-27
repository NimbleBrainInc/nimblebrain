/**
 * The driver for nimblebrain-agent (`nimblebrain-agent acp`), NimbleBrain's engine extracted as a
 * standalone ACP agent. Test-only, as Goose's is: it runs nimblebrain-agent as a child of
 * this process, which no installation may do (ADR-0056), so it serves the live
 * parity eval and nothing in `src/`.
 *
 * NimbleBrain imports nothing of nimblebrain-agent. The driver speaks nimblebrain-agent's documented
 * session options (`nimblebrain-agent/session` on `session/new`: system prompt, history,
 * model, limits) and finds the binary by path, so nimblebrain-agent is a peer the way
 * Goose is, not a dependency.
 *
 * Each run gets a nimblebrain-agent process of its own, in a directory of its own that is
 * removed when the run ends, with an environment that names only its model and
 * one provider key. nimblebrain-agent has no tools of its own: everything it calls comes
 * from the run's tool projection.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import {
  type AcpConnectionTarget,
  type AcpDriver,
  type AcpOutcome,
  knownStopReason,
  type ReportedModelCall,
} from "../../../src/execution/acp/driver.ts";
import { userMessageToPrompt } from "../../../src/execution/acp/transcript.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";
import { spawnStdioAgent } from "./stdio-agent-process.ts";

export interface AgentDriverConfig {
  /** nimblebrain-agent's entry: its `src/cli.ts` (run with this Bun) or a `nimblebrain-agent` binary. */
  command: string;
  /** The variable holding the provider key nimblebrain-agent is given. Default: `NB_AGENT_API_KEY`. */
  apiKeyEnv?: string;
}

/** nimblebrain-agent's session options key (its README, "Session options"). */
export const AGENT_SESSION_META_KEY = "nimblebrain-agent/session";

/** nimblebrain-agent's response keys: its own stop reason, and the turn's model calls. */
export const AGENT_STOP_REASON_META_KEY = "nimblebrain-agent/stopReason";
export const AGENT_USAGE_META_KEY = "nimblebrain-agent/usage";

export const DEFAULT_AGENT_API_KEY_ENV = "NB_AGENT_API_KEY";

const PROVIDER_KEY_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function createAgentDriver(
  config: AgentDriverConfig,
  env: Record<string, string | undefined> = process.env,
): AcpDriver {
  return {
    id: "nimblebrain-agent",
    toolSurface: "projection",
    async open(run) {
      const childEnv = agentEnvironment(config, run, env);
      const root = await mkdtemp(join(tmpdir(), "nb-agent-"));
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
        [AGENT_SESSION_META_KEY]: {
          system: run.system,
          history: encodeHistory(priorMessages(run)),
          model: run.config.model,
          maxIterations: run.config.maxIterations,
          maxInputTokens: run.config.maxInputTokens,
          maxOutputTokens: run.config.maxOutputTokens,
          ...(run.config.thinking ? { thinking: run.config.thinking } : {}),
          compaction: run.compaction ?? false,
        },
      };
    },
    prompt(run) {
      const latest = run.messages.at(-1);
      return latest?.role === "user" ? userMessageToPrompt(latest) : [];
    },
    outcome: agentOutcome,
  };
}

/** What nimblebrain-agent reports beyond ACP: its stop reason, and every model call of the turn. */
export function agentOutcome(response: { _meta?: Record<string, unknown> | null }): AcpOutcome {
  const meta = response._meta ?? {};
  const stopReason = knownStopReason(meta[AGENT_STOP_REASON_META_KEY]);
  const usage = meta[AGENT_USAGE_META_KEY] as { calls?: unknown } | undefined;
  const calls = Array.isArray(usage?.calls) ? usage.calls.filter(isReportedCall) : undefined;
  return { ...(stopReason ? { stopReason } : {}), ...(calls ? { calls } : {}) };
}

function isReportedCall(value: unknown): value is ReportedModelCall {
  const c = value as Partial<ReportedModelCall> | null;
  return (
    typeof c?.model === "string" &&
    (c.purpose === "turn" || c.purpose === "summary") &&
    typeof c.usage?.inputTokens === "number" &&
    typeof c.usage.outputTokens === "number"
  );
}

/** The child's environment: its model and the one provider key it needs. */
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
  return { PATH: CHILD_PATH, NB_AGENT_MODEL: run.config.model, [keyVar]: key };
}

/**
 * History in nimblebrain-agent's documented encoding: JSON, with a file part's bytes as
 * `{ "__nb_agent_bytes": <base64> }`.
 */
export function encodeHistory(messages: LanguageModelV4Message[]): string {
  return JSON.stringify(messages, (_key, value) =>
    value instanceof Uint8Array
      ? { __nb_agent_bytes: Buffer.from(value).toString("base64") }
      : value,
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
