/**
 * The `execution` block of `nimblebrain.json`: which agent runtime executes a
 * run (`src/execution/`).
 *
 * The block is the operator's. Which runtime runs a run is installation
 * configuration, never a task author's or a model's choice (ADR-0056). Absent,
 * every run executes on the native engine.
 *
 * Every runtime here runs in this process or outside the installation; none
 * starts an agent as a child of the runtime (ADR-0056). An external agent
 * joins once it runs out of process, reached over a remote transport, with its
 * tools on a run-scoped endpoint and its models on a gateway the installation
 * controls.
 */

/** NimbleBrain's own engine, served as an ACP agent in this process. */
export interface NimbleBrainAcpRuntimeConfig {
  type: "acp";
  driver: "nimblebrain";
}

/** One runtime that reaches its agent over ACP, through a named driver. */
export type AcpRuntimeConfig = NimbleBrainAcpRuntimeConfig;

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

/** Every key any ACP runtime entry may carry, for the config schema drift guard. */
export const ACP_RUNTIME_CONFIG_KEYS: (keyof NimbleBrainAcpRuntimeConfig)[] = ["type", "driver"];
