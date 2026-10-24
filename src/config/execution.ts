/**
 * The `execution` block of `nimblebrain.json`: which agent runtime executes a
 * run (`src/execution/`).
 *
 * The block is the operator's. Which runtime runs a run is installation
 * configuration, never a task author's or a model's choice (ADR-0047). Absent,
 * every run executes on the native engine.
 */

/** NimbleBrain's own engine, served as an ACP agent in this process. */
export interface NimbleBrainAcpRuntimeConfig {
  type: "acp";
  driver: "nimblebrain";
}

/** Goose (`goose acp`), one process per run. */
export interface GooseRuntimeConfig {
  type: "acp";
  driver: "goose";
  /** The Goose binary: a path, or a name looked up on this process's PATH. Default: `goose`. */
  command?: string;
  /**
   * Goose's approval mode. `auto` runs tools without asking; `approve` and
   * `smart_approve` send permission requests, which the runtime answers by
   * policy. Default: `auto`.
   */
  mode?: "auto" | "approve" | "smart_approve";
  /**
   * The variable in this process's environment that holds the provider key
   * Goose is given. A dedicated, restricted key, never the runtime's own.
   * Default: `NB_GOOSE_API_KEY`.
   */
  apiKeyEnv?: string;
}

/** One runtime that reaches its agent over ACP, through a named driver. */
export type AcpRuntimeConfig = NimbleBrainAcpRuntimeConfig | GooseRuntimeConfig;

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
export const ACP_RUNTIME_CONFIG_KEYS: (
  | keyof NimbleBrainAcpRuntimeConfig
  | keyof GooseRuntimeConfig
)[] = ["type", "driver", "command", "mode", "apiKeyEnv"];
