/**
 * The model a slot gets when the config names none.
 *
 * It follows the configured providers, so an install keyed for any one provider
 * works without setting `models.default`: the runtime never assumes a provider
 * (`providersFromEnv`), and a default naming one it cannot reach would fail
 * every chat. Each hosted provider has one default model here, chosen by hand,
 * because the catalog is synced from upstream and records no preference; a test
 * holds each to a tool-calling catalog entry, so a sync that drops one fails the
 * build rather than every chat.
 */

import { isModelInPolicy } from "./catalog.ts";
import { MODEL_PROVIDERS } from "./registry.ts";

type HostedProvider = (typeof MODEL_PROVIDERS)[number];

/** Each hosted provider's default model, as the id its catalog uses. */
export const PROVIDER_DEFAULT_MODEL: Record<HostedProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.1-sol",
  google: "gemini-4-argon",
  xai: "grok-4.7",
  nebius: "zai-org/GLM-5.3",
  greenpt: "glm-5.3",
};

/**
 * The order a default is picked in when several providers are configured: the
 * hosted providers in `MODEL_PROVIDERS` order, then `local`. Fixed, so the
 * default does not depend on the order a config file or an environment lists
 * them in.
 */
const PREFERENCE = [...MODEL_PROVIDERS, "local"] as const;

/** Used when no configured provider supplies one: none is configured, or a model gateway reaches them all. */
export const FALLBACK_DEFAULT_MODEL = `anthropic:${PROVIDER_DEFAULT_MODEL.anthropic}`;

/**
 * The default model for these configured providers, as `provider:model`: the
 * first configured provider in `PREFERENCE` with a model both its `models`
 * allowlist and the organization's `modelPolicy.allowed` permit. Within a
 * provider, its default model comes first, then the allowlist's models in
 * order, then the policy's. `local` has no default of its own, so it supplies
 * its first listed model. With none, `FALLBACK_DEFAULT_MODEL`, whose turns then
 * fail naming the provider that is not configured.
 */
export function defaultModelFor(
  providers: Record<string, { models?: string[] } | undefined>,
  policy?: string[],
): string {
  for (const id of PREFERENCE) {
    const cfg = providers[id];
    if (!cfg) continue;
    const listed = cfg.models?.filter((m) => m.trim()) ?? [];
    const prefix = `${id}:`;
    const fromPolicy = (policy ?? [])
      .filter((q) => q.startsWith(prefix))
      .map((q) => q.slice(prefix.length));
    const candidates = [
      ...(id === "local" ? [] : [PROVIDER_DEFAULT_MODEL[id]]),
      ...listed,
      ...fromPolicy,
    ];
    const pick = candidates.find(
      (m) =>
        (listed.length === 0 ? id !== "local" : listed.includes(m)) &&
        isModelInPolicy(`${prefix}${m}`, policy),
    );
    if (pick) return `${prefix}${pick}`;
  }
  return FALLBACK_DEFAULT_MODEL;
}
