import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, ProviderV4 } from "@ai-sdk/provider";
import { createXai } from "@ai-sdk/xai";
import {
  createProviderRegistry,
  defaultSettingsMiddleware,
  type Provider,
  wrapLanguageModel,
} from "ai";
import { wrapFetchWithLiveness } from "./fetch-liveness.ts";
import { googleStreamErrorMiddleware } from "./google-stream-error.ts";
import { requireQualifiedModelId } from "./model-id.ts";

export interface ProvidersConfig {
  providers?: {
    anthropic?: { apiKey?: string; models?: string[] };
    openai?: {
      apiKey?: string;
      baseURL?: string;
      organization?: string;
      models?: string[];
    };
    google?: { apiKey?: string; models?: string[] };
    greenpt?: { apiKey?: string; baseURL?: string; models?: string[] };
    nebius?: { apiKey?: string; baseURL?: string; models?: string[] };
    xai?: { apiKey?: string; baseURL?: string; models?: string[] };
  };
}

/**
 * The installation's model gateway (`execution.modelGateway`), which holds the
 * providers' keys and serves each provider at `/<provider>/` in its own API
 * (ADR-0057). With one, every provider is reached through it: the runtime holds
 * no key, and `fetch` presents a model credential it mints for each call.
 */
export interface ModelGatewayAccess {
  /** The gateway's root URL. */
  url: string;
  /** Every call to the gateway goes through it: it carries the call's credential. */
  fetch: typeof fetch;
}

/**
 * The key a gateway-reached provider's client is built with. The client needs
 * one; the gateway's fetch removes it from every request, which carries the
 * call's model credential instead.
 */
const GATEWAY_KEY_PLACEHOLDER = "via-model-gateway";

/** Every provider the runtime builds, by the provider half of a model id. */
export const MODEL_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "nebius",
  "greenpt",
] as const;

/**
 * A provider's base URL on the model gateway: its own path, then the version
 * prefix its client expects (Gemini's API is `v1beta`, every other one `v1`).
 */
export function modelGatewayBaseURL(gatewayUrl: string, provider: string): string {
  const root = gatewayUrl.replace(/\/+$/, "");
  return `${root}/${provider}/${provider === "google" ? "v1beta" : "v1"}`;
}

/**
 * Where and how one provider's client calls: through the gateway (its base URL
 * there, the placeholder key, the gateway's fetch) when the installation has
 * one, and `undefined` otherwise.
 */
function gatewayClient(
  id: string,
  gateway: ModelGatewayAccess | undefined,
): { baseURL: string; apiKey: string; fetch: typeof fetch } | undefined {
  if (!gateway) return undefined;
  return {
    baseURL: modelGatewayBaseURL(gateway.url, id),
    apiKey: GATEWAY_KEY_PLACEHOLDER,
    fetch: gateway.fetch,
  };
}

/** GreenPT's OpenAI-compatible inference endpoint. */
const GREENPT_DEFAULT_BASE_URL = "https://api.greenpt.ai/v1";

/** Nebius Token Factory's OpenAI-compatible inference endpoint. */
const NEBIUS_DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

/**
 * The fields a provider may not set behind a gateway, and why: the gateway
 * holds the key and decides where each provider is, and which models an
 * organization may use is `modelPolicy`'s. Each refuses the boot rather than
 * being ignored, so no setting stops working without a word.
 */
const GATEWAY_REFUSED_FIELDS = {
  apiKey: "the gateway holds the provider's key",
  baseURL: "the gateway decides where the provider is",
  models: "narrow models with modelPolicy.allowed",
} as const;

function assertNothingBesideGateway(config: ProvidersConfig): void {
  for (const [id, cfg] of Object.entries(config.providers ?? {})) {
    for (const [field, why] of Object.entries(GATEWAY_REFUSED_FIELDS)) {
      if (cfg && (cfg as Record<string, unknown>)[field] !== undefined) {
        throw new Error(
          `providers.${id}.${field} is set, but execution.modelGateway reaches every provider: ${why}; remove providers.${id}.${field}`,
        );
      }
    }
  }
}

/**
 * Build a provider registry from config. With the installation's gateway, every
 * provider the runtime knows (`MODEL_PROVIDERS`) is built through it, whatever
 * `providers` names; which of them the gateway serves is its own answer
 * (`watchGatewayProviders`). Without one, each configured provider is built
 * with its own key.
 */
export function buildRegistry(config: ProvidersConfig, gateway?: ModelGatewayAccess): Provider {
  if (gateway) assertNothingBesideGateway(config);
  const providersCfg = gateway
    ? Object.fromEntries(MODEL_PROVIDERS.map((id) => [id, config.providers?.[id] ?? {}]))
    : (config.providers ?? { anthropic: {} });

  const providers: Record<string, ProviderV4> = {};

  if (providersCfg.anthropic)
    providers.anthropic = anthropicProvider(providersCfg.anthropic, gateway);
  if (providersCfg.openai) providers.openai = openaiProvider(providersCfg.openai, gateway);
  if (providersCfg.google) providers.google = googleProvider(providersCfg.google, gateway);
  if (providersCfg.greenpt) providers.greenpt = greenptProvider(providersCfg.greenpt, gateway);
  if (providersCfg.nebius) providers.nebius = nebiusProvider(providersCfg.nebius, gateway);
  if (providersCfg.xai) providers.xai = xaiProvider(providersCfg.xai, gateway);

  return createProviderRegistry(providers);
}

type ProviderConfig<K extends keyof NonNullable<ProvidersConfig["providers"]>> = NonNullable<
  NonNullable<ProvidersConfig["providers"]>[K]
>;

function anthropicProvider(
  cfg: ProviderConfig<"anthropic">,
  gateway: ModelGatewayAccess | undefined,
): ProviderV4 {
  const via = gatewayClient("anthropic", gateway);
  const { apiKey } = cfg;
  // Wrap fetch with the transport-liveness tap so the stream watchdog re-arms
  // on Anthropic's swallowed `ping` keep-alives — otherwise a healthy-but-slow
  // stream at large context trips the idle deadline. See fetch-liveness.ts.
  // The cast bridges an unused member: the SDK types `fetch` as the full
  // `typeof fetch` (incl. Bun's static `preconnect`) but only ever invokes the
  // call signature, which the wrapper implements.
  const anthropic = createAnthropic({
    apiKey: via?.apiKey ?? apiKey,
    ...(via ? { baseURL: via.baseURL } : {}),
    fetch: wrapFetchWithLiveness(via?.fetch ?? globalThis.fetch) as typeof fetch,
  });
  // `toolStreaming: false` keeps Anthropic's fine-grained (eager) tool-input
  // streaming off. The adapter turns it on for every tool by default, and
  // with it on the API streams tool arguments without validating them as
  // JSON, so a malformed argument string reaches the engine as a failed
  // call. The engine never forwards `tool-input-delta` (src/model/stream.ts),
  // so eager streaming buys nothing here. Off, the API validates the
  // arguments before it streams them. A caller can still opt back in per
  // call; call-level provider options merge over this default.
  const toolStreamingOff = defaultSettingsMiddleware({
    settings: { providerOptions: { anthropic: { toolStreaming: false } } },
  });
  return {
    ...anthropic,
    languageModel: (modelId: string) =>
      wrapLanguageModel({
        model: anthropic.languageModel(modelId),
        middleware: toolStreamingOff,
      }),
  };
}

function openaiProvider(
  cfg: ProviderConfig<"openai">,
  gateway: ModelGatewayAccess | undefined,
): ProviderV4 {
  const { apiKey, baseURL, organization } = cfg;
  // No fail-closed key guard: createOpenAI reads `OPENAI_API_KEY` on its own,
  // and when `baseURL` points at an OpenAI-compatible proxy
  // (LiteLLM/Helicone/Azure) that proxy legitimately expects that key — so
  // the fallback is the desired behavior here, not a hazard. See the nebius
  // branch below for the rule.
  const via = gatewayClient("openai", gateway);
  return createOpenAI(via ? { ...via, organization } : { apiKey, baseURL, organization });
}

function googleProvider(
  cfg: ProviderConfig<"google">,
  gateway: ModelGatewayAccess | undefined,
): ProviderV4 {
  const { apiKey } = cfg;
  const via = gatewayClient("google", gateway);
  const google = createGoogleGenerativeAI(via ?? { apiKey });
  // An error Gemini sends inside the stream fails the call, direct or through
  // the gateway, which passes the stream through as sent (google-stream-error.ts).
  return {
    ...google,
    languageModel: (modelId: string) =>
      wrapLanguageModel({
        model: google.languageModel(modelId),
        middleware: googleStreamErrorMiddleware,
      }),
  };
}

function greenptProvider(
  cfg: ProviderConfig<"greenpt">,
  gateway: ModelGatewayAccess | undefined,
): ProviderV4 {
  const { apiKey, baseURL } = cfg;
  const via = gatewayClient("greenpt", gateway);
  const greenptApiKey = via?.apiKey ?? apiKey ?? process.env.GREENPT_API_KEY;
  if (!greenptApiKey) {
    throw new Error(
      "Provider 'greenpt' is configured but no API key is set. " +
        "Set providers.greenpt.apiKey or the GREENPT_API_KEY environment variable.",
    );
  }
  // See the `nebius` branch below for why an OpenAI-compatible gateway is
  // built through `createOpenAICompatible` and why the key guard fails
  // closed — the reasoning is identical and stated once, there.
  //
  // `includeUsage` and `supportsStructuredOutputs` are measured against the
  // live API on glm-5.2, kimi-k2.7-code, and kimi-k3: streamed responses
  // carry non-zero usage, and `json_schema` response formats are honoured.
  // Without `includeUsage` every turn would meter at zero;
  // `supportsStructuredOutputs` matters only to a call that sends a
  // schema-bearing `responseFormat`.
  return createOpenAICompatible({
    name: "greenpt",
    apiKey: greenptApiKey,
    baseURL: via?.baseURL ?? baseURL ?? GREENPT_DEFAULT_BASE_URL,
    ...(via ? { fetch: via.fetch } : {}),
    includeUsage: true,
    supportsStructuredOutputs: true,
  });
}

function nebiusProvider(
  cfg: ProviderConfig<"nebius">,
  gateway: ModelGatewayAccess | undefined,
): ProviderV4 {
  const { apiKey, baseURL } = cfg;
  const via = gatewayClient("nebius", gateway);
  // Nebius Token Factory is an OpenAI-compatible gateway for open-weight
  // models, so it is built through the adapter written for exactly that —
  // `createOpenAICompatible` — rather than through `createOpenAI` pointed at
  // a foreign `baseURL`. It binds Chat Completions natively (Nebius serves no
  // Responses API), so no `.chat()` re-wrap is needed.
  //
  // The key is resolved explicitly and FAILS CLOSED when absent. This is the
  // one place the guard rule is stated, because it is the only branch that
  // needs a guard: an adapter that reads an env variable of its own can be
  // handed an undefined key and still work, so it gets none, while
  // `createOpenAICompatible` reads no environment at all — a keyless nebius
  // has no path forward. Throwing at boot beats an unauthenticated 401 on the
  // first chat turn. Don't "unify" the branches on symmetry grounds.
  const nebiusApiKey = via?.apiKey ?? apiKey ?? process.env.NEBIUS_API_KEY;
  if (!nebiusApiKey) {
    throw new Error(
      "Provider 'nebius' is configured but no API key is set. " +
        "Set providers.nebius.apiKey or the NEBIUS_API_KEY environment variable.",
    );
  }
  // Three of these are load-bearing, and each replaces something
  // `createOpenAI` did unconditionally. This adapter is generic, so what the
  // OpenAI adapter assumed must be asked for by name.
  //
  // `name` — provider options are read under it, so the engine sends
  //   `providerOptions.nebius`, not `openai`. See `buildNebiusThinkingOptions`.
  // `includeUsage` — sets `stream_options.include_usage`. Nebius returns
  //   `"usage": null` on every chunk without it (measured), so the engine's
  //   only path (`doStream`) would meter every turn at zero: no cost, no
  //   ledger tokens, no reasoning tokens.
  // `supportsStructuredOutputs` — without it a schema-bearing
  //   `responseFormat` degrades to `{"type":"json_object"}`, dropping the
  //   schema and strict decoding.
  return createOpenAICompatible({
    name: "nebius",
    apiKey: nebiusApiKey,
    baseURL: via?.baseURL ?? baseURL ?? NEBIUS_DEFAULT_BASE_URL,
    ...(via ? { fetch: via.fetch } : {}),
    includeUsage: true,
    supportsStructuredOutputs: true,
  });
}

function xaiProvider(
  cfg: ProviderConfig<"xai">,
  gateway: ModelGatewayAccess | undefined,
): ProviderV4 {
  const { apiKey, baseURL } = cfg;
  const via = gatewayClient("xai", gateway);
  // No fail-closed key guard: createXai reads XAI_API_KEY on its own, so an
  // absent config key is the normal working case. See the nebius branch above
  // for the rule.
  //
  // Chat Completions is the API this runtime talks to on xai, so `.chat()` is
  // named rather than taken from `.languageModel()`'s default — that default
  // is the adapter's own choice and has moved between adapter majors. The
  // registry test pins `provider === "xai.chat"`; adopting `.responses()` is a
  // deliberate change to make there, not one to inherit from a version bump.
  const xai = createXai(via ?? { apiKey, baseURL });
  return { ...xai, languageModel: (modelId: string) => xai.chat(modelId) };
}

/**
 * Each configured provider's model allowlist (`providers.<id>.models`), the one
 * provider field `buildRegistry` does not read. With no `providers` block it
 * reports `{ anthropic: {} }`, the provider the registry builds by default.
 *
 * `buildRegistry` and this function are the only readers of a provider's
 * config, which `test/unit/model-provider-config.test.ts` holds against the
 * config schema: a declared field neither reads fails the build.
 */
export function providerModelAllowlists(
  config: ProvidersConfig,
): Record<string, { models?: string[] }> {
  if (!config.providers) return { anthropic: {} };
  const result: Record<string, { models?: string[] }> = {};
  for (const [id, cfg] of Object.entries(config.providers)) {
    result[id] = { models: cfg?.models };
  }
  return result;
}

/**
 * Build a function that resolves `provider:model` ids to LanguageModelV4 instances.
 * If no providers configured, defaults to anthropic with env var fallback.
 */
export function buildModelResolver(
  config: ProvidersConfig,
  gateway?: ModelGatewayAccess,
): (modelString: string) => LanguageModelV4 {
  const provider = buildRegistry(config, gateway);

  return (modelString: string): LanguageModelV4 =>
    provider.languageModel(requireQualifiedModelId(modelString)) as LanguageModelV4;
}
