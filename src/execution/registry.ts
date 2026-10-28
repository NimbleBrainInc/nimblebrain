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
  for (const [id, entry] of Object.entries(config?.runtimes ?? {})) {
    add(createAcpRuntime(id, driverFor(id, entry, deps)));
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

/** The driver a runtime entry names, once the entry is known to run as configured. */
function driverFor(id: string, entry: AgentRuntimeConfig, deps: AgentRuntimeDeps): AcpDriver {
  assertRunnable(id, entry, deps);
  return createNimbleBrainAgentDriver({
    id,
    url: entry.url,
    ...(entry.modelEndpoint ? { modelEndpoint: entry.modelEndpoint } : {}),
    connectionCredential: deps.connectionCredential,
  });
}

/**
 * An external runtime reaches its worker over HTTP(S), and outside the dev
 * identity provider it needs the installation's run key (the worker accepts
 * only a connection credential signed with it) and a model gateway (the only
 * model endpoint an installation's agents may call, ADR-0057). A model
 * gateway is reached with the turn's credential, which only a run key mints.
 */
function assertRunnable(id: string, entry: AgentRuntimeConfig, deps: AgentRuntimeDeps): void {
  const where = `execution.runtimes.${id}`;
  if (!isHttpUrl(entry.url)) throw new Error(`${where}.url must be an http(s) URL`);
  if (entry.modelEndpoint !== undefined && !isHttpUrl(entry.modelEndpoint)) {
    throw new Error(`${where}.modelEndpoint must be an http(s) URL`);
  }
  if (entry.modelEndpoint && !deps.connectionCredential) {
    throw new Error(
      `${where}.modelEndpoint needs the installation's run key, which mints the turn's model credential`,
    );
  }
  if (deps.dev) return;
  if (!deps.connectionCredential) {
    throw new Error(`${where} needs the installation's run key to sign its connection credential`);
  }
  if (!entry.modelEndpoint) {
    throw new Error(
      `${where} needs a modelEndpoint: outside the dev identity provider an external agent calls models only through the installation's gateway`,
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
