/**
 * The `execution` block of `nimblebrain.json`: which agent runtime executes a
 * run (`src/execution/`).
 *
 * The block is the operator's. Which runtime runs a run is installation
 * configuration, never a task author's or a model's choice (ADR-0047). Absent,
 * every run executes on the native engine.
 */

/** One runtime that reaches its agent over ACP, through a named driver. */
export interface AcpRuntimeConfig {
  type: "acp";
  /** The driver that knows how to reach the agent: `nimblebrain` is NimbleBrain's own engine. */
  driver: "nimblebrain";
}

export type AgentRuntimeConfig = AcpRuntimeConfig;

/** The `execution` block, as an operator writes it. */
export interface ExecutionConfig {
  /** The runtime every run executes on: `native`, or a name under `runtimes`. Default: `native`. */
  default?: string;
  /** Runtimes beside the native engine, by the name `default` refers to them. */
  runtimes?: Record<string, AgentRuntimeConfig>;
}

/** Every key of {@link ExecutionConfig}, for the config schema drift guard. */
export const EXECUTION_CONFIG_KEYS: (keyof ExecutionConfig)[] = ["default", "runtimes"];

/** Every key of {@link AcpRuntimeConfig}, for the config schema drift guard. */
export const ACP_RUNTIME_CONFIG_KEYS: (keyof AcpRuntimeConfig)[] = ["type", "driver"];
