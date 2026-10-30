/**
 * ACP's standard fields for what a run hands an agent beyond its tools, used
 * for any agent that advertises them, so a driver carries only what ACP has no
 * field for (both fields are unstable in the spec):
 *
 * - `systemPrompt` on `session/new` (`sessionCapabilities.systemPrompt`): the
 *   door's system prompt, as `override` when the agent takes it, else `append`.
 * - `providers/*` (`agentCapabilities.providers`): every provider the agent
 *   lists that the installation's gateway serves, in a protocol the agent
 *   supports for it, is routed to its path on the gateway with that protocol
 *   and the run's model credential as its one header. Any other provider is
 *   turned off, so the agent's model calls reach the gateway or nothing; a run
 *   whose agent requires a provider the gateway cannot serve is refused.
 *   Only with a gateway and a credential: without them the agent
 *   calls its providers as it is configured (a developer's machine).
 *
 * The credential travels only to the agent, as a header it presents to the
 * gateway; it is never logged.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import { MODEL_PROVIDERS, modelGatewayBaseURL } from "../../model/registry.ts";
import type { ResolvedRun } from "../types.ts";
import type { AcpStandardDelivery } from "./driver.ts";

type AgentCapabilities = acp.InitializeResponse["agentCapabilities"];

/**
 * The protocol (ACP `apiType`) the gateway speaks at each provider's path: the
 * provider's own API, which for xAI, Nebius and GreenPT is OpenAI's.
 */
const GATEWAY_PROTOCOL: Record<(typeof MODEL_PROVIDERS)[number], acp.LlmProtocol> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "gemini",
  xai: "openai",
  nebius: "openai",
  greenpt: "openai",
};

/** The run's system prompt in ACP's field, when the agent takes it and there is one. */
export function standardSystemPrompt(
  capabilities: AgentCapabilities,
  run: ResolvedRun,
): acp.SystemPrompt | undefined {
  const takes = capabilities?.sessionCapabilities?.systemPrompt;
  if (!takes || !run.system) return undefined;
  return {
    mode: takes.mode?.override ? "override" : "append",
    content: [{ type: "text", text: run.system }],
  };
}

/**
 * Route the agent's providers to the gateway with the run's credential, when
 * the agent takes `providers/*` and the run has a gateway and a credential.
 * Resolves whether the run's model access went this way.
 */
export async function deliverModelAccess(
  agent: Pick<acp.ClientContext, "request">,
  capabilities: AgentCapabilities,
  run: ResolvedRun,
  modelGateway: string | undefined,
): Promise<boolean> {
  if (!capabilities?.providers || !modelGateway || !run.modelCredential) return false;
  const { providers } = await agent.request(acp.methods.agent.providers.list, {});
  for (const provider of providers) {
    const { providerId, supported, required } = provider;
    const apiType = Object.hasOwn(GATEWAY_PROTOCOL, providerId)
      ? GATEWAY_PROTOCOL[providerId as keyof typeof GATEWAY_PROTOCOL]
      : undefined;
    if (apiType && supported.includes(apiType)) {
      await agent.request(acp.methods.agent.providers.set, {
        providerId,
        apiType,
        baseUrl: modelGatewayBaseURL(modelGateway, providerId),
        headers: { Authorization: `Bearer ${run.modelCredential}` },
      });
    } else if (required) {
      throw new Error(
        `the agent requires provider "${providerId}", which the installation's gateway does not serve in a protocol the agent supports for it`,
      );
    } else {
      await agent.request(acp.methods.agent.providers.disable, { providerId });
    }
  }
  return true;
}

/** What went by ACP's own fields, for the driver to leave out of its `_meta`. */
export function delivered(
  systemPrompt: acp.SystemPrompt | undefined,
  modelAccess: boolean,
): AcpStandardDelivery {
  return { systemPrompt: systemPrompt !== undefined, modelAccess };
}
