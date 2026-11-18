/**
 * A local model server named by the environment.
 *
 * A Docker install's only channel from the installer to the runtime is its
 * `.env`, which Compose passes through; the config file lives in the data
 * volume. So when `NB_LOCAL_MODEL_URL` is set, the runtime builds
 * `providers.local` and the `default` and `fast` model slots from the
 * environment. The config file wins wherever it speaks: a `providers.local`
 * block, or a model slot, set there is kept, and each slot it leaves unset gets
 * the local model.
 */

export const LOCAL_MODEL_ENV = {
  url: "NB_LOCAL_MODEL_URL",
  model: "NB_LOCAL_MODEL",
  context: "NB_LOCAL_MODEL_CONTEXT",
} as const;

interface LocalModelConfig {
  providers?: Record<string, unknown>;
  models?: { default?: string; fast?: string };
}

/**
 * The `providers` and `models` the environment implies, or nothing when it
 * names no local server. Throws when it names one without a model, or with a
 * context window that is not a positive integer, so a half-set install fails
 * at boot rather than on the first chat.
 */
export function localModelFromEnv(
  config: LocalModelConfig,
  env: Record<string, string | undefined>,
): Pick<LocalModelConfig, "providers" | "models"> {
  const baseURL = env[LOCAL_MODEL_ENV.url]?.trim();
  if (!baseURL) return {};
  const model = env[LOCAL_MODEL_ENV.model]?.trim();
  if (!model) {
    throw new Error(
      `${LOCAL_MODEL_ENV.url} is set but ${LOCAL_MODEL_ENV.model} is not; name the model the server serves`,
    );
  }
  const contextText = env[LOCAL_MODEL_ENV.context]?.trim();
  const contextWindow = contextText ? Number(contextText) : undefined;
  if (contextWindow !== undefined && !(Number.isInteger(contextWindow) && contextWindow > 0)) {
    throw new Error(`${LOCAL_MODEL_ENV.context} must be a positive integer, got "${contextText}"`);
  }

  // With no providers block the runtime would build Anthropic alone; keep it
  // only when a key for it is present, so a local-only install offers only the
  // local model.
  const base = config.providers ?? (env.ANTHROPIC_API_KEY?.trim() ? { anthropic: {} } : {});
  const providers =
    "local" in base
      ? base
      : {
          ...base,
          local: { baseURL, models: [model], ...(contextWindow ? { contextWindow } : {}) },
        };

  const qualified = `local:${model}`;
  const models = {
    ...config.models,
    default: config.models?.default ?? qualified,
    fast: config.models?.fast ?? qualified,
  };

  return { providers, models };
}
