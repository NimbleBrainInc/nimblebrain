/**
 * Which models a bench run covers, by preset. `NB_BENCH_MODELS` (a comma list)
 * overrides any preset.
 *
 * - `quick`: one current model per provider, to check a change reaches every
 *   provider's wire format. Run before a PR that touches the prompt or tools.
 * - `full`: the providers' main tiers plus the local models people run, to rank
 *   models for a recommendation. Run before changing a default or the docs.
 *
 * A model whose provider has no key in the environment is reported as skipped,
 * so a preset runs with whatever keys a person has.
 */

export const PRESETS: Record<string, string[]> = {
  quick: [
    "anthropic:claude-sonnet-5-5",
    "openai:gpt-5.6",
    "google:gemini-3.8-flash",
    "xai:grok-4.7",
    "nebius:Qwen/Qwen3.5-397B-A17B",
    "greenpt:gemma4",
    "local:nimblebrain-gemma4-e4b",
  ],
  full: [
    "anthropic:claude-opus-5-5",
    "anthropic:claude-sonnet-5-5",
    "anthropic:claude-haiku-5-5",
    "anthropic:claude-sonnet-4-6",
    "openai:gpt-6.1-sol",
    "openai:gpt-5.6",
    "openai:gpt-5.4-mini",
    "google:gemini-3.1-pro-preview",
    "google:gemini-3.8-flash",
    "xai:grok-4.7",
    "xai:grok-4.5",
    "nebius:Qwen/Qwen3.5-397B-A17B",
    "nebius:moonshotai/Kimi-K2.6",
    "nebius:openai/gpt-oss-120b",
    "greenpt:gemma4",
    "greenpt:glm-5.2",
    "local:nimblebrain-gemma4-e4b",
    "local:nimblebrain-gemma4-26b",
    "local:nimblebrain-gpt-oss-20b",
    "local:nimblebrain-qwen3.6-35b",
  ],
};

/** The environment variable each provider's key is read from, as the runtime reads it. */
export const KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  xai: "XAI_API_KEY",
  nebius: "NEBIUS_API_KEY",
  greenpt: "GREENPT_API_KEY",
};
