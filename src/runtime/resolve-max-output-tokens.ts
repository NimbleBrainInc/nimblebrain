import { DEFAULT_MAX_OUTPUT_TOKENS } from "../limits.ts";
import { getModelByString } from "../model/catalog.ts";

export interface ResolveMaxOutputTokensInput {
  /** Operator/tenant-level override from runtime config. */
  configValue?: number;
  /** Resolved model string (e.g. "anthropic:claude-opus-4-7"). Used for catalog lookup. */
  model?: string;
}

/**
 * Resolve the effective `maxOutputTokens` for an LLM call.
 *
 * The model's catalog `limits.output` is the natural ceiling — operator
 * overrides are clamped down to it so a too-large value can't fail the
 * API call. The catalog is the source of truth (synced via
 * `bun run sync-models`); the static `DEFAULT_MAX_OUTPUT_TOKENS` only
 * applies when the model isn't in the catalog at all (typos, brand-new
 * models pre-sync).
 *
 * Priority:
 *   1. Operator config override (clamped to the catalog ceiling if known).
 *   2. Catalog `limits.output` for the resolved model.
 *   3. `DEFAULT_MAX_OUTPUT_TOKENS` fallback (catalog miss).
 */
export function resolveMaxOutputTokens(input: ResolveMaxOutputTokensInput): number {
  const modelMax = input.model ? getModelByString(input.model)?.limits.output : undefined;
  const ceiling = modelMax && modelMax > 0 ? modelMax : undefined;

  if (typeof input.configValue === "number" && input.configValue > 0) {
    return ceiling ? Math.min(input.configValue, ceiling) : input.configValue;
  }
  if (ceiling) return ceiling;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
