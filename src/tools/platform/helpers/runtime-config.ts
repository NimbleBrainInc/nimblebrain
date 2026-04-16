import { readFileSync } from "node:fs";

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

export function getRuntimeConfig(configPath: string): RuntimeConfigResult {
  let raw: Record<string, unknown> = {};
  try {
    const content = readFileSync(configPath, "utf-8");
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // File missing or invalid — use defaults
  }

  const providers = raw.providers as Record<string, unknown> | undefined;
  const configuredProviders = providers ? Object.keys(providers) : ["anthropic"];

  const prefs = raw.preferences as Record<string, unknown> | undefined;
  const home = raw.home as Record<string, unknown> | undefined;

  return {
    defaultModel: (raw.defaultModel as string) ?? "anthropic:claude-sonnet-4-6",
    maxIterations: (raw.maxIterations as number) ?? 10,
    maxInputTokens: (raw.maxInputTokens as number) ?? 500_000,
    maxOutputTokens: (raw.maxOutputTokens as number) ?? 16_384,
    configuredProviders,
    preferences: {
      displayName: (prefs?.displayName as string) ?? (home?.userName as string) ?? "",
      timezone: (prefs?.timezone as string) ?? (home?.timezone as string) ?? "",
      locale: (prefs?.locale as string) ?? "en-US",
      theme: (prefs?.theme as string) ?? "system",
    },
  };
}
