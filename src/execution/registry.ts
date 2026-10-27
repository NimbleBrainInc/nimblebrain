/**
 * The runtimes an installation can execute runs on. The native engine is
 * always present; any other is handed to the runtime at start
 * (`RuntimeConfig.execution`), since none is configured from `nimblebrain.json`
 * until an external agent can be reached out of process (ADR-0056, ADR-0057).
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createNativeRuntime, NATIVE_RUNTIME_ID } from "./native-runtime.ts";
import type { AgentRuntime } from "./types.ts";

/** Which runtime executes a run, and the runtimes beside the native engine. */
export interface ExecutionConfig {
  /** The runtime every run executes on: `native`, or the id of one in `runtimes`. Default: `native`. */
  default?: string;
  /** Runtimes beside the native engine, each under its own `id`. */
  runtimes?: AgentRuntime[];
}

export interface AgentRuntimes {
  /**
   * The runtime `execution.default` names (`native` when unset). Read per
   * run, so changing the default retargets the next run.
   */
  select(defaultId: string | undefined): AgentRuntime;
}

/** Index every runtime. Throws when `execution.default` names a runtime that does not exist. */
export function createAgentRuntimes(
  config: ExecutionConfig | undefined,
  deps: { resolveModel(model: string): LanguageModelV4 },
): AgentRuntimes {
  const runtimes = new Map<string, AgentRuntime>([
    [NATIVE_RUNTIME_ID, createNativeRuntime(deps.resolveModel)],
  ]);
  for (const runtime of config?.runtimes ?? []) {
    if (runtimes.has(runtime.id)) {
      throw new Error(`execution.runtimes: "${runtime.id}" is named twice`);
    }
    runtimes.set(runtime.id, runtime);
  }
  const select = (defaultId: string | undefined): AgentRuntime => {
    const id = defaultId ?? NATIVE_RUNTIME_ID;
    const runtime = runtimes.get(id);
    if (!runtime)
      throw new Error(`execution.default names "${id}", which is not a configured runtime`);
    return runtime;
  };
  // A default that names nothing fails the boot, not the first run.
  select(config?.default);
  return { select };
}
