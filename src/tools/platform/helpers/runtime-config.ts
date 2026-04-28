import type { Runtime } from "../../../runtime/runtime.ts";

export interface RuntimeConfigResult {
  defaultModel: string;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  configuredProviders: string[];
  preferences: {
    displayName: string;
    timezone: string;
    locale: string;
    theme: string;
  };
}

/**
 * Shape the runtime configuration for the settings UI.
 *
 * Delegates entirely to the live `Runtime` instance — the resolver-aware
 * source of truth. Reading the config file independently here would
 * duplicate logic and drift (e.g. before this refactor, this helper
 * returned a static 16,384 fallback for `maxOutputTokens` while the
 * runtime returned a catalog-derived value, silently undermining the
 * fix when the operator opened + saved the model settings page).
 *
 * Per-user identity preferences override these tenant defaults at the
 * call site (see `settings.ts`'s `config` tool handler).
 */
export function getRuntimeConfig(runtime: Runtime): RuntimeConfigResult {
  const cfg = runtime.getRuntimeConfig();
  const tenantPrefs = runtime.getTenantDefaultPreferences();
  return {
    defaultModel: cfg.defaultModel,
    maxIterations: cfg.maxIterations,
    maxInputTokens: cfg.maxInputTokens,
    maxOutputTokens: cfg.maxOutputTokens,
    configuredProviders: runtime.getConfiguredProviders(),
    preferences: {
      displayName: tenantPrefs.displayName ?? "",
      timezone: tenantPrefs.timezone ?? "",
      locale: tenantPrefs.locale ?? "en-US",
      theme: tenantPrefs.theme ?? "system",
    },
  };
}
