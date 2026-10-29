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
 * calls go to the installation's one model gateway with a credential the
 * runtime mints per turn.
 */

/** One runtime beside the native engine: a worker serving an ACP agent. */
export interface AgentRuntimeConfig {
  /** The agent the worker serves, which names the driver that speaks to it. */
  driver: "nimblebrain-agent";
  /** The worker's ACP endpoint, dialed over Streamable HTTP. */
  url: string;
}

/** The `execution` block, as an operator writes it. */
export interface ExecutionConfig {
  /** The runtime every run executes on: `native`, or a name under `runtimes`. Default: `native`. */
  default?: string;
  /**
   * The installation's model gateway, by its root URL: each provider is served
   * at `<gateway>/<provider>`. Every external agent's model endpoint, reached
   * with the turn's credential, and the endpoint of each provider configured
   * `gateway: true`. Required outside the dev identity provider for external
   * runtimes; absent, a worker calls its own provider with its own key.
   */
  modelGateway?: string;
  /** Runtimes beside the native engine, by the name `default` refers to them. */
  runtimes?: Record<string, AgentRuntimeConfig>;
}

/** Every key of {@link ExecutionConfig}, for the config schema drift guard. */
export const EXECUTION_CONFIG_KEYS: (keyof ExecutionConfig)[] = [
  "default",
  "modelGateway",
  "runtimes",
];

/** Every key a runtime entry may carry, for the config schema drift guard. */
export const AGENT_RUNTIME_CONFIG_KEYS: (keyof AgentRuntimeConfig)[] = ["driver", "url"];
