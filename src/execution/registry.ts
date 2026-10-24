/**
 * The runtimes an installation can execute runs on, built once at boot from
 * the `execution` block. The native runtime is always present.
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { AcpRuntimeConfig, ExecutionConfig } from "../config/execution.ts";
import { createAcpRuntime } from "./acp/acp-runtime.ts";
import type { AcpDriver } from "./acp/driver.ts";
import { createNimbleBrainDriver } from "./acp/drivers/nimblebrain.ts";
import { createNativeRuntime, NATIVE_RUNTIME_ID } from "./native-runtime.ts";
import type { AgentRuntime } from "./types.ts";

export interface AgentRuntimes {
  /**
   * The runtime `execution.default` names (`native` when unset). Read per
   * run, so changing the default retargets the next run without a restart.
   */
  select(defaultId: string | undefined): AgentRuntime;
}

/** Build every configured runtime. Throws when `execution.default` names a runtime that does not exist. */
export function createAgentRuntimes(
  config: ExecutionConfig | undefined,
  deps: { resolveModel(model: string): LanguageModelV4 },
): AgentRuntimes {
  const runtimes = new Map<string, AgentRuntime>([
    [NATIVE_RUNTIME_ID, createNativeRuntime(deps.resolveModel)],
  ]);
  for (const [id, entry] of Object.entries(config?.runtimes ?? {})) {
    if (id === NATIVE_RUNTIME_ID) {
      throw new Error(`execution.runtimes: "${NATIVE_RUNTIME_ID}" is the built-in engine's name`);
    }
    runtimes.set(id, createAcpRuntime(id, driverFor(entry, deps)));
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

/** The driver an ACP runtime entry names. A new ACP agent is a new case here. */
function driverFor(
  entry: AcpRuntimeConfig,
  deps: { resolveModel(model: string): LanguageModelV4 },
): AcpDriver {
  switch (entry.driver) {
    case "nimblebrain":
      return createNimbleBrainDriver(deps);
  }
}
