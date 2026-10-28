/**
 * The `execution` block of `nimblebrain.json`: which agent runtime executes a
 * run (`src/execution/`).
 *
 * The block is the operator's. Which runtime runs a run is installation
 * configuration, never a task author's or a model's choice (ADR-0056). Absent,
 * every run executes on the native engine.
 *
 * An external runtime is an agent served as a worker outside the runtime's
 * process, which the runtime dials over ACP's Streamable HTTP transport and
 * never starts (ADR-0057). Its tools travel on that connection; its model
 * calls go to the installation's model gateway with a credential the runtime
 * mints per turn.
 */

/** NimbleBrain's agent loop as a standalone worker (`nimblebrain-agent serve`). */
export interface NimbleBrainAgentRuntimeConfig {
  type: "acp";
  driver: "nimblebrain-agent";
  /** The worker's ACP endpoint. */
  url: string;
  /**
   * The model gateway the agent's calls go to, with the turn's credential.
   * Required outside the dev identity provider; absent, the worker calls its
   * own provider with its own key.
   */
  modelEndpoint?: string;
}

/** One runtime beside the native engine. */
export type AgentRuntimeConfig = NimbleBrainAgentRuntimeConfig;

/** The `execution` block, as an operator writes it. */
export interface ExecutionConfig {
  /** The runtime every run executes on: `native`, or a name under `runtimes`. Default: `native`. */
  default?: string;
  /** Runtimes beside the native engine, by the name `default` refers to them. */
  runtimes?: Record<string, AgentRuntimeConfig>;
}

/** Every key of {@link ExecutionConfig}, for the config schema drift guard. */
export const EXECUTION_CONFIG_KEYS: (keyof ExecutionConfig)[] = ["default", "runtimes"];

/** Every key a runtime entry may carry, for the config schema drift guard. */
export const AGENT_RUNTIME_CONFIG_KEYS: (keyof NimbleBrainAgentRuntimeConfig)[] = [
  "type",
  "driver",
  "url",
  "modelEndpoint",
];
