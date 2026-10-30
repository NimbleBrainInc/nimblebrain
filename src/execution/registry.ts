/**
 * The runtimes an installation can execute runs on, built once at boot. The
 * native engine is always present; each external runtime `execution.runtimes`
 * configures is an agent worker the runtime dials (ADR-0057); an embedder or a
 * test may hand in more (`RuntimeConfig.agentRuntimes`).
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { AgentRuntimeConfig, ExecutionConfig } from "../config/execution.ts";
import { createAcpRuntime } from "./acp/acp-runtime.ts";
import type { AcpDriver } from "./acp/driver.ts";
import { createNimbleBrainAgentDriver } from "./acp/drivers/nimblebrain-agent.ts";
import { createHttpConnection } from "./acp/http-connection.ts";
import { createNativeRuntime, NATIVE_RUNTIME_ID } from "./native-runtime.ts";
import type { AgentRuntime } from "./types.ts";

export interface AgentRuntimes {
  /**
   * The runtime `execution.default` names (`native` when unset). Read per
   * run, so changing the default retargets the next run.
   */
  select(defaultId: string | undefined): AgentRuntime;
}

export interface AgentRuntimeDeps {
  resolveModel(model: string): LanguageModelV4;
  /**
   * Mints the credential presented to an external worker on every request,
   * or null where the installation has no run key.
   */
  connectionCredential: (() => string) | null;
  /**
   * Whether the instance runs the `dev` identity provider: the one case an
   * external runtime may run without a model gateway and a run key, against a
   * worker on the developer's own machine (ADR-0057).
   */
  dev: boolean;
}

/**
 * Index every runtime. Throws when a configured runtime cannot run as
 * configured, or when `execution.default` names a runtime that does not
 * exist: a misconfiguration fails the boot, not the first run.
 */
export function createAgentRuntimes(
  config: ExecutionConfig | undefined,
  injected: AgentRuntime[],
  deps: AgentRuntimeDeps,
): AgentRuntimes {
  const runtimes = new Map<string, AgentRuntime>([
    [NATIVE_RUNTIME_ID, createNativeRuntime(deps.resolveModel)],
  ]);
  const add = (runtime: AgentRuntime) => {
    if (runtimes.has(runtime.id)) {
      throw new Error(`execution.runtimes: "${runtime.id}" is named twice`);
    }
    runtimes.set(runtime.id, runtime);
  };
  const entries = Object.entries(config?.runtimes ?? {});
  if (entries.length > 0) assertGatewayed(config ?? {}, deps);
  for (const [id, entry] of entries) {
    if (!isHttpUrl(entry.url))
      throw new Error(`execution.runtimes.${id}.url must be an http(s) URL`);
    const connection = createHttpConnection({
      url: entry.url,
      credential: deps.connectionCredential,
    });
    const driver = driverFor(entry, config?.modelGateway);
    assertPoolable(id, driver);
    add(
      createAcpRuntime(id, driver, connection, {
        ...(config?.modelGateway ? { modelGateway: config.modelGateway } : {}),
      }),
    );
  }
  for (const runtime of injected) add(runtime);

  const select = (defaultId: string | undefined): AgentRuntime => {
    const id = defaultId ?? NATIVE_RUNTIME_ID;
    const runtime = runtimes.get(id);
    if (!runtime)
      throw new Error(`execution.default names "${id}", which is not a configured runtime`);
    return runtime;
  };
  select(config?.default);
  return { select };
}

/** The driver for the agent a runtime entry names. */
function driverFor(entry: AgentRuntimeConfig, modelGateway: string | undefined): AcpDriver {
  switch (entry.driver) {
    case "nimblebrain-agent":
      return createNimbleBrainAgentDriver(modelGateway ? { modelGateway } : {});
  }
}

/**
 * External runtimes reach models through the installation's one gateway (the
 * only model endpoint an installation's agents may call, ADR-0057), with the
 * turn's credential, which only the run key mints; and a worker accepts only
 * a connection credential signed with that key. Outside the dev identity
 * provider both are required.
 */
function assertGatewayed(config: ExecutionConfig, deps: AgentRuntimeDeps): void {
  const gateway = config.modelGateway;
  if (gateway !== undefined && !isHttpUrl(gateway)) {
    throw new Error("execution.modelGateway must be an http(s) URL");
  }
  if (gateway && !deps.connectionCredential) {
    throw new Error(
      "execution.modelGateway needs the installation's run key, which mints the turn's model credential",
    );
  }
  if (deps.dev) return;
  if (!deps.connectionCredential) {
    throw new Error(
      "execution.runtimes needs the installation's run key to sign the connection credential",
    );
  }
  if (!gateway) {
    throw new Error(
      "execution.runtimes needs execution.modelGateway: outside the dev identity provider an external agent calls models only through the installation's gateway",
    );
  }
}

/**
 * A configured runtime is a pool of shared workers, which may serve only an
 * agent whose tools are the run's projection alone. An agent with tools of its
 * own acts on the host it runs on, so it runs in a sandbox per session, never
 * on a shared worker (ADR-0057).
 */
export function assertPoolable(id: string, driver: AcpDriver): void {
  if (driver.toolSurface !== "projection") {
    throw new Error(
      `execution.runtimes.${id}: its agent has tools of its own, so it cannot run on a shared worker pool`,
    );
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
