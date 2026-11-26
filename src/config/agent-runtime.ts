/**
 * An agent runtime named by the environment.
 *
 * A Docker install's only channel from the installer to the runtime is its
 * `.env`, which Compose passes through; the config file lives in the data
 * volume. So when `NB_AGENT_RUNTIME` names a subscription CLI's driver and
 * `NB_AGENT_RUNTIME_URL` its worker, the runtime adds that runtime to
 * `execution.runtimes` and makes it `execution.default`. A config file that
 * sets `execution` wins whole: the environment adds nothing to it.
 *
 * Nothing here gates who may use it. The registry refuses the `claude-code`
 * and `codex` drivers outside the dev identity provider
 * (`src/execution/registry.ts`), whichever way they were configured.
 */

import type { AgentRuntimeConfig, ExecutionConfig } from "./execution.ts";

export const AGENT_RUNTIME_ENV = {
  runtime: "NB_AGENT_RUNTIME",
  url: "NB_AGENT_RUNTIME_URL",
} as const;

/** The drivers the environment may name: a vendor CLI on the person's own machine. */
const ENV_DRIVERS = ["claude-code", "codex"] as const satisfies AgentRuntimeConfig["driver"][];
type EnvDriver = (typeof ENV_DRIVERS)[number];

export interface AgentRuntimeFromEnv {
  /** The `execution` block to run with, when the environment changes it. */
  execution?: ExecutionConfig;
  /** Why the environment's runtime was not used, for a boot warning. */
  ignored?: string;
}

/**
 * The `execution` block the environment implies. Throws when it names a
 * runtime without a URL, a URL without a runtime, or a runtime that is not a
 * subscription CLI, so a half-set install fails at boot rather than on the
 * first chat. `native`, or neither set, changes nothing.
 */
export function agentRuntimeFromEnv(
  execution: ExecutionConfig | undefined,
  env: Record<string, string | undefined>,
): AgentRuntimeFromEnv {
  const runtime = env[AGENT_RUNTIME_ENV.runtime]?.trim() ?? "";
  const url = env[AGENT_RUNTIME_ENV.url]?.trim() ?? "";
  if (runtime === "native" || (runtime === "" && url === "")) return {};
  if (runtime === "") {
    throw new Error(
      `${AGENT_RUNTIME_ENV.url} is set but ${AGENT_RUNTIME_ENV.runtime} is not; name its driver`,
    );
  }
  if (!isEnvDriver(runtime)) {
    throw new Error(
      `${AGENT_RUNTIME_ENV.runtime} must be ${ENV_DRIVERS.join(" or ")} (or native), got "${runtime}"`,
    );
  }
  if (url === "") {
    throw new Error(
      `${AGENT_RUNTIME_ENV.runtime} is set but ${AGENT_RUNTIME_ENV.url} is not; name the worker's ACP URL`,
    );
  }
  if (execution !== undefined) {
    return {
      ignored: `${AGENT_RUNTIME_ENV.runtime}=${runtime} is ignored: nimblebrain.json sets execution, which wins`,
    };
  }
  return {
    execution: { default: runtime, runtimes: { [runtime]: { driver: runtime, url } } },
  };
}

function isEnvDriver(value: string): value is EnvDriver {
  return (ENV_DRIVERS as readonly string[]).includes(value);
}
