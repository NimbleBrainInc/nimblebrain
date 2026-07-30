import type {
  JSONSchema7,
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import { DEFAULT_MAX_DIRECT_TOOLS, MAX_ITERATIONS, MAX_LENGTH_CONTINUATIONS } from "../limits.ts";
import { applyCachePolicy } from "../model/cache-policy.ts";
import {
  GOOGLE_THINKING_LEVELS,
  type GoogleThinkingLevel,
  getProviderFromModel,
  googleThinkingSupport,
  OPENAI_EFFORTS,
  openaiSupportedEfforts,
  supportsEnabledThinking,
  XAI_EFFORTS,
  type XAIEffort,
  xaiSupportedEfforts,
} from "../model/catalog.ts";
import { normalizeForReplay } from "../model/inbound-fit.ts";
import { callModel, type StreamResult } from "../model/stream.ts";
import { log } from "../observability/log.ts";
import { toolMatches } from "../skills/select.ts";
import { coerceInputForSchema } from "../tools/coerce-input.ts";
import { bareToolName, splitInnerToolName } from "../tools/namespace.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import type { TokenUsage } from "../usage/types.ts";
import { addUsage, emptyUsage, tokenUsageFromV3 } from "../usage/types.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import {
  boundToolResultForModel,
  estimateContentSize,
  extractResourceLinks,
  extractTextForModel,
  type ResourceLinkInfo,
  textContent,
} from "./content-helpers.ts";
import { isContextOverflowError } from "./context-overflow.ts";
import { withRetry } from "./retry.ts";
import { createRunSupervisor, type RunSupervisor, type SupervisorVerdict } from "./supervisor.ts";
import { toolSchemaForLlm } from "./tool-schema-for-llm.ts";
import {
  CONNECTOR_SKILL_SYNTHETIC,
  type ConnectorSkillCandidate,
  type EffortSource,
  type EngineConfig,
  type EngineResult,
  type EventSink,
  type FinishReason,
  isInternalTool,
  type ResolvedThinking,
  type StopReason,
  type ThinkingEffort,
  type ToolCall,
  type ToolCallRecord,
  type ToolResult,
  type ToolRouter,
  type ToolSchema,
} from "./types.ts";

/** Default when the env knob is unset or unusable. */
const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 6;

/**
 * Most calls one engine run dispatches to any ONE source at a time.
 *
 * "Per source" describes the grouping, not the enforcement, and the difference
 * is the part the name gets wrong. The bound lives in one `AgentEngine`
 * iteration, while an `McpSource` is long-lived and shared across every
 * conversation in its workspace — and `nb__delegate` gives each sub-agent a
 * fresh engine over the PARENT's router. Concurrent runs and sub-agents
 * therefore each get their own budget; this is not a global rate limit on the
 * source. Sizing guidance is in `docs/config/environment.mdx`.
 *
 * `NB_MAX_PARALLEL_TOOL_CALLS_PER_SOURCE` overrides the default.
 */
const MAX_PARALLEL_TOOL_CALLS_PER_SOURCE_PER_RUN = resolveMaxParallelToolCallsPerSource();

/**
 * Read the per-source-per-run cap from the environment.
 *
 * Exported for tests: the value above is resolved once at module load, so the
 * fallback semantics are otherwise unobservable. A non-numeric, non-finite, or
 * `< 1` value falls back to the default rather than disabling the bound —
 * removing backpressure is never the right reading of a typo.
 */
export function resolveMaxParallelToolCallsPerSource(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = Number(env.NB_MAX_PARALLEL_TOOL_CALLS_PER_SOURCE);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_PARALLEL_TOOL_CALLS;
}

/** Tokens reserved for visible content so thinking can't consume the whole reply. */
const MIN_VISIBLE_OUTPUT_TOKENS = 4096;

/** Anthropic's stated minimum thinking budget. Below this the API rejects. */
const MIN_THINKING_BUDGET_TOKENS = 1024;

/** Share of the available output budget each effort tier is allowed to think with. */
const EFFORT_BUDGET_SHARE: Record<ThinkingEffort, number> = {
  low: 0.15,
  medium: 0.35,
  high: 0.6,
  xhigh: 0.8,
  max: 1,
};

/**
 * Hold a thinking budget below the output ceiling, leaving
 * `MIN_VISIBLE_OUTPUT_TOKENS` for the answer itself.
 *
 * Applies to operator-set budgets as much as derived ones. Not because an
 * oversized budget errors — the Anthropic adapter adds the thinking budget to
 * `max_tokens` rather than fitting it inside, so it inflates the request
 * instead of failing it. The point is that the operator's output ceiling stops
 * meaning anything if thinking can raise it, and a budget that consumes the
 * whole visible share produces the empty turn the Opus 4.7 incident was.
 */
function clampThinkingBudget(budget: number, maxOutputTokens: number): number {
  return Math.max(
    MIN_THINKING_BUDGET_TOKENS,
    Math.min(budget, maxOutputTokens - MIN_VISIBLE_OUTPUT_TOKENS),
  );
}

/**
 * Size a token budget from a chosen depth, for providers that meter thinking
 * in tokens (Anthropic up to 4.6, Gemini 2.5).
 *
 * This direction is sound where the reverse was not: the operator named a
 * depth, and the model's own output ceiling is the natural scale to express it
 * against. Deriving a *depth* from a ceiling nobody set was the defect — there
 * was no intent in that number to recover.
 */
function effortToBudget(effort: ThinkingEffort, maxOutputTokens: number): number {
  const available = maxOutputTokens - MIN_VISIBLE_OUTPUT_TOKENS;
  return Math.max(MIN_THINKING_BUDGET_TOKENS, Math.floor(available * EFFORT_BUDGET_SHARE[effort]));
}

/**
 * Clamp the platform ladder onto OpenAI's usable range.
 *
 * The adapter accepts `xhigh`, but its own documentation restricts that value
 * to GPT-5.1-Codex-Max and says an unsupported model errors — and the adapter
 * does no per-model gating, it just forwards the string. `high` is accepted by
 * every OpenAI reasoning model, so both top tiers land there rather than
 * turning a depth preference into a failed request.
 */
function toOpenAIEffort(effort: ThinkingEffort): "low" | "medium" | "high" {
  // Nebius's own API enumerates the wider set, but it shares this adapter and
  // this key, and `high` is the strongest tier both accept — so both clamp.
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/** Map the platform ladder onto Google's level names; Google's tops out at `high`. */
function toGoogleLevel(effort: ThinkingEffort): GoogleThinkingLevel {
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/** xAI's ladder tops out at `high`, so the two tiers above it clamp. */
function toXaiEffort(effort: ThinkingEffort): XAIEffort {
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/**
 * The deepest level at or below the one requested that this model accepts.
 *
 * Support is per-model, not per-generation, so an operator's tier may simply
 * not exist here — `gemini-3-pro-preview` has no `medium`. Only steps down:
 * stepping up would think harder than the operator asked for, which is a worse
 * surprise than not honoring the tier, and no current row would ever reach it
 * anyway (every level set contains `minimal` or `low`).
 *
 * `undefined` when the model offers nothing at or below the request — the
 * caller then sends no level and the provider's own default stands.
 */
function nearestSupported<T extends string>(
  wanted: T,
  supported: ReadonlySet<string>,
  ladder: readonly T[],
): T | undefined {
  for (let d = ladder.indexOf(wanted); d >= 0; d--) {
    const l = ladder[d];
    if (l && supported.has(l)) return l;
  }
  return undefined;
}

/**
 * Which tier to actually send, for any dialect carrying a per-model tier set.
 * Both Google's levels and OpenAI's efforts obey the same three-part rule:
 *
 *   - the model offers what was asked for → send it
 *   - it doesn't, and the tier is the platform's own fallback rather than
 *     something an operator wrote → send nothing, and let the model's default
 *     stand. A tier nobody chose must not override the provider's own
 *     judgement, and on Google stepping *down* can reason less than `off` does
 *     on a model with no `minimal`.
 *   - it doesn't, and an operator did choose it → step to the nearest tier at
 *     or below. Never up: reasoning harder than asked is a worse surprise than
 *     not honoring the tier.
 *
 * `undefined` means send no tier at all. Note the operator's choice can end up
 * silently unapplied where nothing at or below it exists — see #809.
 */
function pickTier<T extends string>(
  wanted: T,
  supported: ReadonlySet<string>,
  ladder: readonly T[],
  source: EffortSource,
): T | undefined {
  if (supported.has(wanted)) return wanted;
  if (source !== "operator") return undefined;
  return nearestSupported(wanted, supported, ladder);
}

/**
 * Build Anthropic's thinking options.
 *
 * Anthropic speaks two dialects and the split is per-model: 4.7, 4.8, and the
 * 5-series reject `thinking.type=enabled` and take `thinking.type=adaptive`
 * plus `output_config.effort`; everything earlier takes `thinking.type=enabled`
 * with a token budget.
 */
function buildAnthropicThinkingOptions(
  model: string,
  thinking: ResolvedThinking,
  maxOutputTokens: number,
): SharedV3ProviderOptions {
  const effortShaped = !supportsEnabledThinking(model);

  switch (thinking.mode) {
    case "off":
      // Nothing to send. The adapter only serializes `thinking` when the type
      // is `enabled` or `adaptive`, so `{type:"disabled"}` never reaches the
      // wire for any model — emitting it just looked like enforcement.
      // Anthropic's own default is not to think, which is what actually makes
      // `off` work on the models where it works.
      return {};
    case "adaptive":
      return { anthropic: { thinking: { type: "adaptive" } } };
    case "effort":
    case "enabled": {
      // Effort-shaped models take the tier either way: a token budget can't be
      // metered there, but the depth chosen alongside it can.
      if (effortShaped) {
        return { anthropic: { thinking: { type: "adaptive" }, effort: thinking.effort } };
      }
      const budgetTokens =
        thinking.mode === "enabled"
          ? clampThinkingBudget(thinking.budgetTokens, maxOutputTokens)
          : effortToBudget(thinking.effort, maxOutputTokens);
      return { anthropic: { thinking: { type: "enabled", budgetTokens } } };
    }
  }
}

/**
 * Build OpenAI's options. `@ai-sdk/openai` parses provider options under the
 * literal name `"openai"` regardless of the `name` its instance was created
 * with, so this key is fixed rather than derived.
 *
 * Nebius is NOT routed here even though it speaks the same wire protocol — it
 * is built through `createOpenAICompatible`, which reads options under its
 * instance name. See `buildNebiusThinkingOptions`.
 */
function buildOpenAIThinkingOptions(
  model: string,
  thinking: ResolvedThinking,
): SharedV3ProviderOptions {
  switch (thinking.mode) {
    case "off":
      // `reasoningEffort: "none"` exists but the adapter documents it as
      // GPT-5.1-only and an error elsewhere. Omitting the option leaves the
      // model at its own default, which is the closest honest thing — on
      // o-series models reasoning cannot be turned off at all.
      return {};
    case "adaptive":
      // No adaptive equivalent; the model applies its own per-call default.
      return {};
    case "effort":
    case "enabled": {
      // `gpt-5-pro` rejects `medium` — the platform fallback — so without
      // this a stock install 400s on every call to it.
      const tier = pickTier(
        toOpenAIEffort(thinking.effort),
        openaiSupportedEfforts(model),
        OPENAI_EFFORTS,
        thinking.source,
      );
      return tier ? { openai: { reasoningEffort: tier } } : {};
    }
  }
}

/**
 * Build Nebius's options.
 *
 * Same wire parameter as OpenAI (`reasoning_effort`) under a different options
 * key: `createOpenAICompatible` reads `providerOptions.<name>`, and the registry
 * names this instance `nebius`. Sending `openai` here reaches the wire as
 * nothing at all — no error, every call at the model's own default.
 *
 * No per-model table, unlike OpenAI and xAI. Nebius accepts all three tiers on
 * every catalog model (measured), and the catalog is curated + probe-verified by
 * `sync-nebius`, so there is no unmeasured id to fail closed against. Its floor
 * is `low`, so `off` has nothing to send.
 */
function buildNebiusThinkingOptions(thinking: ResolvedThinking): SharedV3ProviderOptions {
  switch (thinking.mode) {
    case "off":
    case "adaptive":
      // Nebius has no value meaning "don't reason" and no adaptive equivalent;
      // either way the model applies its own default.
      return {};
    case "effort":
    case "enabled":
      return { nebius: { reasoningEffort: toOpenAIEffort(thinking.effort) } };
  }
}

/**
 * Build xAI's options.
 *
 * A separate function from the OpenAI one on purpose, for two independent
 * reasons — do not merge them.
 *
 * 1. **The key differs.** `@ai-sdk/xai` reads `providerOptions.xai`, where
 *    `@ai-sdk/openai` hardcodes `openai` regardless of the instance name. An
 *    `openai` key here is silently dropped: no error, every call at the model's
 *    own default. The rule is that a provider-options key follows its *adapter*,
 *    not the wire protocol it speaks.
 * 2. **`off` is honorable here.** `reasoning_effort: "none"` measurably
 *    suppresses (`reasoning_tokens: 0`), so `off` sends something instead of
 *    giving up — the first effort-dialect model where it can. The other
 *    effort-shaped providers have no value meaning "don't" (OpenAI's floor is
 *    `minimal`, Nebius's is `low`), so their `off` sends nothing. Google
 *    suppresses too, but through the budget dialect's `thinkingBudget: 0`
 *    (`googleBudgetOptions`) rather than a tier.
 *
 * Support is per-model and fail-closed: a model with no measured ladder, or a
 * measured-empty one (reasons but exposes no knob), gets nothing rather than a
 * guess. Sending a tier to those 400s the call outright.
 */
function buildXaiThinkingOptions(
  model: string,
  thinking: ResolvedThinking,
): SharedV3ProviderOptions {
  const supported = xaiSupportedEfforts(model);
  if (!supported || supported.size === 0) return {};

  switch (thinking.mode) {
    case "off":
      // Only where measured — `grok-4.5` rejects `none` while taking the rest,
      // so this cannot be assumed from the provider.
      return supported.has("none") ? { xai: { reasoningEffort: "none" } } : {};
    case "adaptive":
      // No adaptive equivalent; the model applies its own per-call default.
      return {};
    case "effort":
    case "enabled": {
      const tier = pickTier(toXaiEffort(thinking.effort), supported, XAI_EFFORTS, thinking.source);
      return tier ? { xai: { reasoningEffort: tier } } : {};
    }
  }
}

/** Google models already warned about, so an unmapped one is reported once per process. */
const warnedUnmappedGoogle = new Set<string>();

/** Gemini 3's dialect: a named level, from the set this specific model accepts. */
function googleLevelOptions(
  thinking: ResolvedThinking,
  levels: ReadonlySet<GoogleThinkingLevel>,
): SharedV3ProviderOptions {
  if (thinking.mode === "adaptive") return {};
  if (thinking.mode === "off") {
    // `minimal` is the only level meaning "barely think", and not every Gemini 3
    // model offers it. Stepping up to `low` would answer "don't reason" with an
    // instruction to reason, so say nothing — the same choice made for
    // Anthropic, OpenAI, and the Gemini 2.5 models that can't disable thinking.
    return levels.has("minimal")
      ? { google: { thinkingConfig: { thinkingLevel: "minimal" } } }
      : {};
  }
  const level = pickTier(
    toGoogleLevel(thinking.effort),
    levels,
    GOOGLE_THINKING_LEVELS,
    thinking.source,
  );
  return level ? { google: { thinkingConfig: { thinkingLevel: level } } } : {};
}

/** Gemini 2.5's dialect: a token budget, inside the model's own documented range. */
function googleBudgetOptions(
  thinking: ResolvedThinking,
  support: { min: number; max: number; canDisable: boolean },
  maxOutputTokens: number,
): SharedV3ProviderOptions {
  switch (thinking.mode) {
    case "off":
      // 2.5 Pro cannot stop thinking; a zero budget there is rejected.
      return support.canDisable ? { google: { thinkingConfig: { thinkingBudget: 0 } } } : {};
    case "adaptive":
      return { google: { thinkingConfig: { thinkingBudget: -1 } } };
    case "effort":
    case "enabled": {
      const requested =
        thinking.mode === "enabled"
          ? thinking.budgetTokens
          : effortToBudget(thinking.effort, maxOutputTokens);
      // Two ceilings apply: the model's own thinking range, and the room left
      // in this call's output budget for a visible answer.
      const ceiling = Math.min(support.max, maxOutputTokens - MIN_VISIBLE_OUTPUT_TOKENS);
      // Floor above the model's own minimum as well as Anthropic's, because on
      // a model whose minimum is 0 that value is the *disable* sentinel: a
      // tight output ceiling would otherwise turn "reason as hard as possible"
      // into "do not reason", byte-identical to `off`. The Anthropic path
      // floors the same way and degrades to thinking a little.
      const floor = Math.max(support.min, MIN_THINKING_BUDGET_TOKENS);
      return {
        google: {
          thinkingConfig: { thinkingBudget: Math.max(floor, Math.min(requested, ceiling)) },
        },
      };
    }
  }
}

/**
 * Build Google Gemini options.
 *
 * Which dialect a model speaks — and which levels or budgets it accepts — is
 * per-model and comes from `googleThinkingSupport`. A model with no verified
 * entry gets nothing, which is what every Google model got before this wiring
 * existed; sending a guessed dialect is how a stock install starts returning
 * 400s.
 */
function buildGoogleThinkingOptions(
  model: string,
  thinking: ResolvedThinking,
  maxOutputTokens: number,
): SharedV3ProviderOptions {
  const support = googleThinkingSupport(model);
  if (!support) {
    // Fail closed, but not silently. This is the likelier path than the
    // resolver's own capability gate — most reasoning-capable Google models in
    // the catalog have no row — and an operator who set a depth on one of them
    // otherwise gets nothing at all, right after release notes saying Google
    // is wired. Skip the platform's own fallback tier: nobody asked for it.
    const operatorAsked =
      thinking.mode === "off" || thinking.mode === "adaptive"
        ? true
        : thinking.source !== "platform";
    if (operatorAsked && !warnedUnmappedGoogle.has(model)) {
      warnedUnmappedGoogle.add(model);
      log.warn(
        `[thinking] No published thinking support for "${model}", so no reasoning options are ` +
          "sent and it runs at Google's default. Add a row to GOOGLE_THINKING in " +
          "src/model/catalog.ts once its supported levels or budget range are documented. " +
          "Logged once per model.",
      );
    }
    return {};
  }
  return support.dialect === "level"
    ? googleLevelOptions(thinking, support.levels)
    : googleBudgetOptions(thinking, support, maxOutputTokens);
}

/**
 * Translate the platform's provider-neutral thinking config into the call's
 * `providerOptions` shape.
 *
 * Every provider is reached through one table here, so the resolver upstream
 * never has to know which dialect a model speaks — it decides whether to
 * reason and how hard, and this decides how to say it.
 */
function buildThinkingProviderOptions(
  model: string,
  thinking: ResolvedThinking | undefined,
  maxOutputTokens: number,
): SharedV3ProviderOptions {
  if (!thinking) return {};
  switch (getProviderFromModel(model)) {
    case "anthropic":
      return buildAnthropicThinkingOptions(model, thinking, maxOutputTokens);
    case "openai":
      return buildOpenAIThinkingOptions(model, thinking);
    case "nebius":
      return buildNebiusThinkingOptions(thinking);
    case "xai":
      return buildXaiThinkingOptions(model, thinking);
    case "google":
      return buildGoogleThinkingOptions(model, thinking, maxOutputTokens);
    default:
      // Unknown provider: say nothing and let it apply its own default.
      return {};
  }
}

/**
 * True if any reasoning (extended-thinking) block in the content lacks its
 * provider signature. A signed thinking block round-trips on replay; an
 * unsigned one — produced when `finishReason: "length"` cuts the model off
 * mid-thinking, before the signature arrives (src/model/stream.ts) — cannot
 * be replayed as the trailing assistant message: Anthropic rejects it
 * ("thinking blocks in the latest assistant message cannot be modified",
 * src/model/inbound-fit.ts). The signature lives at
 * `providerMetadata.anthropic.signature`. Conservative for other providers:
 * any reasoning block we can't confirm is signed counts as unsigned, so the
 * caller surfaces the truncation instead of risking a 400.
 */
function hasUnsignedReasoning(content: LanguageModelV3Content[]): boolean {
  for (const block of content) {
    if (block.type !== "reasoning") continue;
    const meta = (block as { providerMetadata?: Record<string, unknown> }).providerMetadata;
    const anthropic = meta?.anthropic as { signature?: unknown } | undefined;
    const signed = typeof anthropic?.signature === "string" && anthropic.signature.length > 0;
    if (!signed) return true;
  }
  return false;
}

/**
 * Whether a no-tool-call turn that hit the output ceiling can be auto-resumed
 * from its partial text. False once MAX_LENGTH_CONTINUATIONS is reached, or when
 * the turn's reasoning was cut off unsigned — replaying that as the trailing
 * assistant message is exactly what Anthropic rejects.
 */
function canResumeFromLength(
  finishReason: FinishReason | undefined,
  lengthContinuations: number,
  content: LanguageModelV3Content[],
): boolean {
  return (
    finishReason === "length" &&
    lengthContinuations < MAX_LENGTH_CONTINUATIONS &&
    !hasUnsignedReasoning(content)
  );
}

/**
 * Map a per-call finish reason to a run-level stop reason. Called once
 * the agent loop has exited (no pending tool calls). The iteration cap
 * is checked first by the caller — this only handles model-driven exits.
 */
function deriveStopReason(finish: FinishReason | undefined): StopReason {
  switch (finish) {
    case "stop":
      return "complete";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    case "error":
      return "error";
    case "tool-calls":
      // Loop only exits when toolCalls.length === 0; reaching here with
      // finish="tool-calls" means the model declared tool calls but the
      // stream produced no parsable ones. Surface as "other" rather than
      // pretending it was a clean stop.
      return "other";
    default:
      return "other";
  }
}

/**
 * Sanitize messages before sending to the LLM API.
 * Removes empty text content blocks that cause "text content blocks must be non-empty" errors.
 * This can happen when conversation history contains assistant messages from tool-only turns.
 */
function sanitizeMessages(messages: LanguageModelV3Message[]): LanguageModelV3Message[] {
  return messages.map((msg): LanguageModelV3Message => {
    // System messages have string content — pass through unchanged
    if (msg.role === "system") return msg;
    if (!Array.isArray(msg.content)) return msg;

    const filtered = msg.content.filter((part) => {
      if ("type" in part && part.type === "text" && "text" in part) {
        return typeof part.text === "string" && part.text.length > 0;
      }
      return true;
    });

    // If all content was filtered out, keep a minimal text block
    if (filtered.length === 0) {
      return {
        ...msg,
        content: [{ type: "text" as const, text: "(empty)" }],
      } as LanguageModelV3Message;
    }

    return filtered.length === msg.content.length
      ? msg
      : ({ ...msg, content: filtered } as LanguageModelV3Message);
  });
}

/**
 * Seed the connector-skill dedup set from history metadata. Kept as a fallback
 * for callers that pass metadata-bearing messages directly (the engine+store
 * integration test): on the real chat path `rehydrateUserResources` strips
 * message `metadata` (where the synthetic marker lives) before the engine sees
 * the messages, so this scan can't be the sole source there. No-op when there
 * are no candidates.
 */
function seedInjectedConnectorSkills(
  history: LanguageModelV3Message[],
  connectorSkillCandidates: ConnectorSkillCandidate[],
  injectedConnectorSkills: Set<string>,
): void {
  if (connectorSkillCandidates.length === 0) return;
  for (const m of history) {
    const meta = (m as { metadata?: { synthetic?: string; skill?: string | null } }).metadata;
    if (meta?.synthetic === CONNECTOR_SKILL_SYNTHETIC && typeof meta.skill === "string") {
      injectedConnectorSkills.add(meta.skill);
    }
  }
}

/**
 * Build the router-wide lookups the run needs. Uses ALL tools from the router
 * (not just the direct/surfaced subset passed to the LLM) because tiered
 * surfacing may proxy UI-annotated tools:
 *   - `toolAnnotations`: tool name → MCP annotations (UI metadata like resourceUri).
 *   - `allToolSchemaMap`: tool name → schema (used to resolve agent-promoted tools).
 */
function buildToolLookups(allRouterTools: ToolSchema[]): {
  toolAnnotations: Map<string, Record<string, unknown>>;
  allToolSchemaMap: Map<string, ToolSchema>;
} {
  const toolAnnotations = new Map<string, Record<string, unknown>>();
  for (const t of allRouterTools) {
    if (t.annotations) toolAnnotations.set(t.name, t.annotations);
  }

  const allToolSchemaMap = new Map<string, ToolSchema>();
  for (const t of allRouterTools) {
    allToolSchemaMap.set(t.name, t);
  }

  return { toolAnnotations, allToolSchemaMap };
}

/** Throw the abort reason if the run's signal is already aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}

/** Apply the transformPrompt hook when present; otherwise the system prompt verbatim. */
function resolveCallPrompt(config: EngineConfig, systemPrompt: string): string {
  return config.hooks?.transformPrompt ? config.hooks.transformPrompt(systemPrompt) : systemPrompt;
}

/**
 * On the final allowed iteration, append the wrap-up system-reminder as a TAIL
 * message, not by appending to the system prompt: mutating the system block
 * would bust its (1-hour) cache breakpoint — and the whole message prefix after
 * it — on the final call of every run. As a tail message the reminder rides the
 * volatile (5-minute) region and leaves the stable prefix byte-identical, so the
 * final call still reads it from cache. Merge into a trailing user turn when
 * present to avoid consecutive user messages; otherwise append a fresh one.
 * No-op on any earlier iteration.
 */
function appendFinalStepReminder(
  callMessages: LanguageModelV3Message[],
  iteration: number,
  maxIter: number,
): LanguageModelV3Message[] {
  if (iteration !== maxIter - 1) return callMessages;
  const finalStep =
    "<system-reminder>This is your final step. Do NOT call any more tools. " +
    "Summarize what you have accomplished so far and clearly list what remains " +
    "unfinished so the user can continue in a follow-up message.</system-reminder>";
  const last = callMessages[callMessages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content)) {
    return [
      ...callMessages.slice(0, -1),
      { ...last, content: [...last.content, { type: "text", text: finalStep }] },
    ];
  }
  return [...callMessages, { role: "user", content: [{ type: "text", text: finalStep }] }];
}

/**
 * Map the AI SDK V3 usage shape into our canonical TokenUsage, plus the
 * engine-only 1h/5m cache-write split the base V3 struct doesn't carry.
 * V3's `inputTokens.total` is the grand total (noCache+cacheRead+cacheWrite);
 * we preserve that on TokenUsage.inputTokens and surface the cache subsets as
 * siblings. Cost computation subtracts the subsets from the totals — see
 * src/usage/cost.ts. Anthropic reports the cache-write TTL split under
 * `raw.cache_creation` (ephemeral_1h vs ephemeral_5m). We tier TTL by
 * breakpoint (1h on system+tools, 5m on the rolling history — see
 * model/cache-policy.ts), so capture the 1-hour portion for accurate costing.
 * Absent for providers that don't report it.
 */
function computeTurnUsage(usage: StreamResult["usage"]): TokenUsage {
  const rawCreation = (
    usage.raw as { cache_creation?: { ephemeral_1h_input_tokens?: number } } | undefined
  )?.cache_creation;
  const cacheWrite1h = rawCreation?.ephemeral_1h_input_tokens;
  return {
    ...tokenUsageFromV3(usage),
    ...(cacheWrite1h != null ? { cacheWrite1hTokens: cacheWrite1h } : {}),
  };
}

/** Parse a tool call's `input` into an object, tolerating the stream's JSON-string form. */
function parseToolCallInput(input: LanguageModelV3ToolCall["input"]): Record<string, unknown> {
  return (typeof input === "string" ? JSON.parse(input) : (input ?? {})) as Record<string, unknown>;
}

/**
 * Coerce a tool call's input against its declared schema, then validate it.
 * Coerce first: models occasionally emit nested object/array values as
 * JSON-encoded strings (`{ manifest: "{...}" }`); the coerce pass uses the
 * schema as a parsing oracle to recover those one-level misencodings before
 * validation. Returns the (possibly coerced) input plus an isError result when
 * validation fails. With no schema the input passes through unchanged.
 */
function coerceAndValidateToolInput(
  input: Record<string, unknown>,
  toolSchema: ToolSchema | undefined,
): { input: Record<string, unknown>; errorResult?: ToolResult } {
  if (!toolSchema?.inputSchema) return { input };
  const schema = toolSchema.inputSchema as Record<string, unknown>;
  const coerced = coerceInputForSchema(input, schema);
  const validation = validateToolInput(coerced, schema);
  if (!validation.valid) {
    return {
      input: coerced,
      errorResult: {
        content: textContent(`Invalid tool input: ${validation.error}`),
        isError: true,
      },
    };
  }
  return { input: coerced };
}

/**
 * Reject an oversized tool result before it propagates through event emission,
 * hooks, or history accumulation — replacing it with an isError summary.
 * `maxToolResultSize` of 0 disables the guard; absent defaults to 1M chars.
 */
function enforceMaxToolResultSize(
  result: ToolResult,
  maxToolResultSize: number | undefined,
): ToolResult {
  const maxResultSize = maxToolResultSize ?? 1_000_000;
  if (maxResultSize <= 0) return result;
  const resultSize = estimateContentSize(result.content);
  if (resultSize <= maxResultSize) return result;
  return {
    content: textContent(
      `Tool result too large (${resultSize.toLocaleString()} chars, limit: ${maxResultSize.toLocaleString()}). ` +
        `Ask the user to constrain the query or use pagination.`,
    ),
    isError: true,
  };
}

/**
 * Assemble the `tool.done` event payload. `result` is attached only when there
 * is an inline-UI resourceUri; `modelOutput` only when bounding actually shrank
 * the text (so small results don't carry a duplicate field, and replay falls
 * back to bounding `output` for legacy events without it); the supervisor fields
 * only when the loop supervisor tripped.
 */
function buildToolDoneData(params: {
  runId: string;
  name: string;
  id: string;
  finalResult: ToolResult;
  ms: number;
  resourceUri: string | undefined;
  outputText: string;
  bounded: boolean;
  modelOutput: string;
  resourceLinks: ResourceLinkInfo[];
  verdict: SupervisorVerdict;
}): Record<string, unknown> {
  const {
    runId,
    name,
    id,
    finalResult,
    ms,
    resourceUri,
    outputText,
    bounded,
    modelOutput,
    resourceLinks,
    verdict,
  } = params;
  return {
    runId,
    name,
    id,
    ok: !finalResult.isError,
    ms,
    resourceUri,
    output: outputText,
    ...(bounded ? { modelOutput } : {}),
    result: resourceUri ? finalResult : undefined,
    ...(resourceLinks.length > 0 ? { resourceLinks } : {}),
    ...(verdict.type === "synth"
      ? {
          supervisorTripped: true,
          trippedTool: verdict.trippedTool,
          consecutiveRepeats: verdict.consecutiveRepeats,
        }
      : {}),
  };
}

/**
 * Turn the iteration's per-tool-call outcomes into the tool-result message parts
 * fed back to the model plus the ToolCallRecord list for run telemetry.
 * `modelOutput` is the already-bounded text the model sees (computed once during
 * execution and persisted on tool.done) — so the live prompt and the replayed
 * prompt carry the identical bounded result. Early-return paths that skip
 * execution (e.g. policy-denied) omit it; bound their small result here so the
 * type stays a string.
 */
function buildToolResults(toolResults: ToolExecResult[]): {
  toolResultParts: LanguageModelV3ToolResultPart[];
  toolCallRecords: ToolCallRecord[];
} {
  const toolResultParts: LanguageModelV3ToolResultPart[] = [];
  const toolCallRecords: ToolCallRecord[] = [];

  for (const {
    toolCall,
    gatedCall,
    result,
    ms,
    resourceUri: uri,
    resourceLinks: links,
    modelOutput,
  } of toolResults) {
    const llmText =
      modelOutput ??
      boundToolResultForModel(extractTextForModel(result.content), { hasUiResource: !!uri });
    toolCallRecords.push({
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      // Reuse the input parsed once in executeToolCall — never re-parse the raw
      // stream string (a malformed input would throw here and abort the run).
      input: gatedCall.input,
      output: llmText,
      ok: !result.isError,
      ms,
      // Surface the structured failure reason (orchestrator routing
      // classes, etc.) so consumers can tell an unroutable connector
      // from a tool that ran and errored. See ToolCallRecord.errorReason.
      ...(result.isError && typeof result.structuredContent?.reason === "string"
        ? { errorReason: result.structuredContent.reason }
        : {}),
      ...(uri ? { resourceUri: uri } : {}),
      ...(links && links.length > 0 ? { resourceLinks: links } : {}),
    });

    toolResultParts.push({
      type: "tool-result",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: result.isError
        ? { type: "error-text", value: llmText }
        : { type: "text", value: llmText },
    });
  }

  return { toolResultParts, toolCallRecords };
}

/** Shape the `run.error` event payload from a thrown value. */
function buildRunErrorData(runId: string, err: unknown): Record<string, unknown> {
  return {
    runId,
    error: err instanceof Error ? err.message : String(err),
    type: err instanceof Error ? err.constructor.name : "Error",
  };
}

/** Per-tool-call context shared across an iteration's concurrent executions. */
interface ToolExecContext {
  config: EngineConfig;
  runId: string;
  toolAnnotations: Map<string, Record<string, unknown>>;
  connectorSkillCandidates: ConnectorSkillCandidate[];
  injectedConnectorSkills: Set<string>;
  toolSchemaMap: Map<string, ToolSchema>;
  promotedLastUsed: Map<string, number>;
  bumpUseCounter: () => number;
  supervisor: RunSupervisor;
}

/** One tool call's outcome, consumed by buildToolResults to shape history + records. */
interface ToolExecResult {
  toolCall: LanguageModelV3ToolCall;
  gatedCall: ToolCall;
  result: ToolResult;
  ms: number;
  resourceUri?: string;
  resourceLinks?: ResourceLinkInfo[];
  modelOutput?: string;
}

export class AgentEngine {
  constructor(
    private model: LanguageModelV3,
    private tools: ToolRouter,
    private events: EventSink,
  ) {}

  async run(
    config: EngineConfig,
    systemPrompt: string,
    messages: LanguageModelV3Message[],
    tools: ToolSchema[],
  ): Promise<EngineResult> {
    // Never mutate the caller's array
    const history = [...messages];
    const maxIter = Math.min(config.maxIterations, MAX_ITERATIONS);

    // Connector-skill overlays: curated guidance surfaced ONCE into the
    // conversation history on the first matching tool call — never into the
    // cached system prefix. The dedup set is seeded primarily from
    // `alreadyInjectedConnectorSkills`, which the runtime computes from the
    // UN-rehydrated history: `rehydrateUserResources` strips message `metadata`
    // (where the synthetic marker lives) before the engine sees the messages,
    // so scanning `history` here can't be the sole source on the real chat
    // path. The scan is kept as a fallback for callers that pass
    // metadata-bearing messages directly (the engine+store integration test).
    // The set also dedups multiple matching calls within this run.
    const connectorSkillCandidates = config.connectorSkillCandidates ?? [];
    const injectedConnectorSkills = new Set<string>(config.alreadyInjectedConnectorSkills ?? []);
    seedInjectedConnectorSkills(history, connectorSkillCandidates, injectedConnectorSkills);

    let iteration = 0;
    const cumulativeUsage: TokenUsage = emptyUsage();
    let cumulativeLlmMs = 0;
    let output = "";
    const allToolCalls: ToolCallRecord[] = [];
    const runId = crypto.randomUUID();

    const allRouterTools = await this.tools.availableTools();
    const { toolAnnotations, allToolSchemaMap } = buildToolLookups(allRouterTools);

    const directTools = [...tools];
    const directToolNames = new Set(directTools.map((t) => t.name));
    // LRU bookkeeping for agent-promoted tools. Initial tools (passed in
    // `tools`) are NEVER tracked here, so the eviction loop can never
    // touch them — they're operator-opted-in. Counter is monotonic so
    // smaller stamp = older, regardless of clock skew or test parallelism.
    const promotedLastUsed = new Map<string, number>();
    let useCounter = 0;
    const bumpUseCounter = () => ++useCounter;
    const maxActiveTools = config.maxActiveTools ?? DEFAULT_MAX_DIRECT_TOOLS;
    // No warning when the initial set exceeds the cap: the always-direct kernel
    // tools alone exceed it, so this is the expected steady state, not a
    // misconfiguration. The cap only bounds agent-promoted tools — an over-cap
    // initial set just makes eviction soft (see evictPromotedToolsToCap).

    const toolControls = {
      addTool: (toolName: string) => {
        if (directToolNames.has(toolName)) {
          // Already-active tool counts as a "use" — refresh LRU stamp so
          // re-promoting a recently-used tool doesn't make it look stale.
          if (promotedLastUsed.has(toolName)) {
            promotedLastUsed.set(toolName, ++useCounter);
          }
          return {
            ok: true,
            toolName,
            changed: false,
            message: `${toolName} is already available in the active tool list.`,
          };
        }
        const schema = allToolSchemaMap.get(toolName);
        if (!schema) {
          return {
            ok: false,
            toolName,
            changed: false,
            reason: "not_found",
            message: `${toolName} was not found in the current tool registry.`,
          };
        }
        if (isInternalTool(schema)) {
          return {
            ok: false,
            toolName,
            changed: false,
            reason: "internal_tool",
            message: `${toolName} is an internal tool and cannot be added to the active tool list.`,
          };
        }
        if (config.toolPromotion && !config.toolPromotion.isToolEligible(schema)) {
          return {
            ok: false,
            toolName,
            changed: false,
            reason: "not_allowed",
            message: `${toolName} is not available in the current run.`,
          };
        }
        directTools.push(schema);
        directToolNames.add(toolName);
        promotedLastUsed.set(toolName, ++useCounter);
        this.events.emit({ type: "tool.promoted", data: { runId, toolName } });

        // A promoted tool makes its server's capability live mid-turn — surface that
        // server's skill guidance once, now, so the model has the workflow before it
        // starts using the tools (not only when the first one is called at tool.start).
        // Delivery rides the history tail (cache-safe — never the frozen prefix), so the
        // guidance reaches the model on the NEXT turn — matching how progressive disclosure
        // unfolds (promote in turn N, call in N+1), not same-iteration.
        this.injectConnectorSkillOverlays(
          runId,
          toolName,
          connectorSkillCandidates,
          injectedConnectorSkills,
        );

        // Backstop: cap active tools by evicting LRU agent-promoted entries.
        // Initial tools are exempt because they're not in `promotedLastUsed`.
        this.evictPromotedToolsToCap(
          runId,
          directTools,
          directToolNames,
          promotedLastUsed,
          maxActiveTools,
          toolName,
        );
        return {
          ok: true,
          toolName,
          changed: true,
          message: `${toolName} is now available in the active tool list.`,
        };
      },
      removeTool: (toolName: string) => {
        // Match the BARE name. Wire names are bare, so the strip is a no-op for
        // anything emitted today; it stays because a name replayed from history
        // can carry the retired `ws_<id>-` prefix, and a raw
        // `startsWith("nb__")` on one of those would let a system tool be
        // released.
        if (bareToolName(toolName).startsWith("nb__")) {
          return {
            ok: false,
            toolName,
            changed: false,
            reason: "system_tool",
            message: `${toolName} is a system tool and cannot be released.`,
          };
        }
        if (!directToolNames.has(toolName)) {
          return {
            ok: true,
            toolName,
            changed: false,
            message: `${toolName} is not in the active tool list.`,
          };
        }
        const idx = directTools.findIndex((t) => t.name === toolName);
        if (idx >= 0) directTools.splice(idx, 1);
        directToolNames.delete(toolName);
        promotedLastUsed.delete(toolName);
        this.events.emit({ type: "tool.released", data: { runId, toolName } });
        return {
          ok: true,
          toolName,
          changed: true,
          message: `${toolName} was removed from the active tool list.`,
        };
      },
    };

    this.events.emit({
      type: "run.start",
      data: {
        runId,
        model: config.model,
        maxIterations: maxIter,
        maxOutputTokens: config.maxOutputTokens,
        maxInputTokens: config.maxInputTokens,
        toolCount: tools.length,
        toolNames: tools.map((t) => t.name),
        systemPromptLength: systemPrompt.length,
        systemPrompt,
        messageCount: messages.length,
        messageRoles: messages.map((m) => m.role),
        estimatedMessageTokens: Math.ceil(JSON.stringify(messages).length / 4),
      },
    });

    this.emitRunPromptMetadata(runId, config);

    const runStart = performance.now();

    // Per-run loop bounding. Watches tool-result repetition by fingerprint
    // and replaces the Nth-repeat result with a synth-stop directive that
    // tells the model to surface the error and end the run. See
    // src/engine/supervisor.ts for the state machine.
    const supervisor = createRunSupervisor();

    // Tracks the most recent LLM call's finish reason so the run-level
    // stop reason can reflect why the model actually exited (length cap,
    // content filter, etc.) rather than always reporting "complete".
    let lastFinishReason: FinishReason | undefined;

    // Auto-resume bookkeeping for output-ceiling truncations. When a turn
    // is cut off at the model's max output tokens (`finishReason: "length"`)
    // with no pending tool call, the engine re-prompts the model to continue
    // from its partial text instead of ending the run with a half-written
    // answer (see the `toolCalls.length === 0` branch). `lengthContinuations`
    // bounds that to `MAX_LENGTH_CONTINUATIONS`; `resumingFromLength`
    // suppresses the inter-turn blank line so the resumed text stitches
    // seamlessly onto the partial.
    let lengthContinuations = 0;
    let resumingFromLength = false;

    const unregisterToolControls = config.toolPromotion?.registerControls(toolControls);
    try {
      while (iteration < maxIter) {
        // Cancellation check at the top of every iteration. Three signal
        // propagation paths now cover the full agent loop:
        //
        //   1. THIS check — between iterations. Catches a cancel that
        //      fires during a tool call (e.g. an external timeout that
        //      fires mid-tool); without it, the engine would proceed to
        //      the next LLM round-trip after the cancelled tool.
        //   2. `tools.execute(call, config.signal)` — in-flight tool.
        //      Task-augmented MCP tools get `tasks/cancel`; inline ones
        //      abort their RPC.
        //   3. `callModel(..., { abortSignal: config.signal })` below —
        //      in-flight LLM stream. The provider aborts the underlying
        //      fetch on signal, so a long completion or reasoning-heavy
        //      run cancels at the network layer instead of blocking
        //      until the model finishes.
        //
        // Cooperative throughout: we never preempt running work, just
        // stop starting new work. The runtime catch translates the
        // thrown AbortError into the appropriate `run.error` event for
        // SSE consumers.
        throwIfAborted(config.signal);

        // Drop any tool the supervisor has tripped this run and build the
        // per-iteration model toolset + schema lookup.
        const { modelTools, toolSchemaMap } = this.buildIterationTools(directTools, supervisor);

        // 1. Apply context/prompt hooks and call LLM. The transformContext
        //    hook is also re-invoked on a context-overflow recovery (see
        //    the call loop below) with `overflowAttempt: 1` so the hook
        //    can return more aggressively trimmed messages.
        const runTransform = (attempt: number): LanguageModelV3Message[] =>
          config.hooks?.transformContext
            ? config.hooks.transformContext([...history], { overflowAttempt: attempt })
            : history;
        const windowed = runTransform(0);
        // Sanitize: filter out empty text content blocks that the API rejects
        let callMessages = sanitizeMessages(windowed);
        const callPrompt = resolveCallPrompt(config, systemPrompt);

        callMessages = appendFinalStepReminder(callMessages, iteration, maxIter);

        const callProviderOptions = buildThinkingProviderOptions(
          config.model,
          config.thinking,
          config.maxOutputTokens,
        );

        const callProvider = getProviderFromModel(config.model);
        const callOnce = (msgs: LanguageModelV3Message[]) => {
          // Provider-scoped prompt-cache policy: places the rolling step-anchor
          // + tail breakpoints (Anthropic) so the growing prefix is read back,
          // not re-written, each iteration. See model/cache-policy.ts.
          //
          // Correctness assumes transformContext keeps the prefix append-only:
          // the rolling anchor must stay byte-identical to the prior call's
          // tail. If a future compaction hook rewrites pre-anchor messages,
          // reads silently become misses (degraded, not incorrect).
          const { prompt: cachedPrompt, tools: cachedTools } = applyCachePolicy({
            provider: callProvider,
            systemPrompt: callPrompt,
            messages: msgs,
            tools: modelTools,
          });
          return withRetry(
            () =>
              callModel(
                this.model,
                {
                  prompt: cachedPrompt,
                  tools: cachedTools,
                  maxOutputTokens: config.maxOutputTokens,
                  // Forward the run-scoped signal into the model call. AI
                  // SDK V3 providers honor `abortSignal` by aborting the
                  // underlying fetch, so an in-flight stream cancels at
                  // the network layer instead of blocking the engine
                  // until the model finishes. Pairs with the iteration-
                  // boundary check above: that handles between-step
                  // cancellation, this handles in-step.
                  ...(config.signal ? { abortSignal: config.signal } : {}),
                  ...(Object.keys(callProviderOptions).length > 0
                    ? { providerOptions: callProviderOptions }
                    : {}),
                },
                (text) => this.events.emit({ type: "text.delta", data: { runId, text } }),
                (text) => this.events.emit({ type: "reasoning.delta", data: { runId, text } }),
                (id, name) =>
                  this.events.emit({ type: "tool.preparing", data: { runId, id, name } }),
                (id) => this.events.emit({ type: "tool.preparing.done", data: { runId, id } }),
              ),
            // Defaults preserved; only the new fourth arg matters here.
            // The retry backoff sleep aborts on `config.signal` so a
            // cancel during backoff bites within the abort tick instead
            // of after the full delay (up to ~8.5s on attempt 3).
            3,
            1000,
            config.signal,
          );
        };

        const llmStart = performance.now();
        const response = await this.callModelWithOverflowRecovery(
          callOnce,
          callMessages,
          runTransform,
          config,
          runId,
        );
        const llmMs = Math.round(performance.now() - llmStart);

        // Accumulate text output (add newline between turns if needed).
        // When this turn is the resumption of a length-truncated one, stitch
        // directly onto the partial with no separator — the model is
        // continuing mid-thought, so a blank line would inject a false break.
        output = this.accumulateAssistantText(output, response.content, resumingFromLength, runId);
        // Consume the resume flag unconditionally: it must not leak into a
        // later iteration if this resumed turn produced no text block (e.g.
        // tool-call- or reasoning-only), which would wrongly glue a genuinely
        // new turn onto the previous one.
        resumingFromLength = false;

        const turnUsage = computeTurnUsage(response.usage);
        addUsage(cumulativeUsage, turnUsage);
        cumulativeLlmMs += llmMs;

        // Track the model's per-call finish reason for downstream
        // observability and the run-level stop reason derivation below.
        // `unified` is non-optional in the V3 spec and stream.ts defaults
        // to "other" if no finish part arrives, so no fallback needed.
        lastFinishReason = response.finishReason.unified;

        // Record the atomic LLM call fact
        this.events.emit({
          type: "llm.done",
          data: {
            runId,
            model: config.model,
            content: response.content,
            usage: turnUsage,
            llmMs,
            // Time-to-first-token of the successful provider call (connect +
            // prefill), distinct from `llmMs` (whole round-trip incl. decode).
            // Absent when the call emitted no output part.
            ttftMs: response.ttftMs,
            finishReason: lastFinishReason,
          },
        });

        // 2. Extract tool calls
        const toolCalls = response.content.filter(
          (b): b is LanguageModelV3ToolCall => b.type === "tool-call",
        );

        if (toolCalls.length === 0) {
          // A turn with no tool call usually means the model is done — but
          // `finishReason: "length"` means it was cut off at the output
          // ceiling mid-answer, not finished. Re-prompt it to continue from
          // its partial text instead of ending the run with a truncated
          // response. Bounded by MAX_LENGTH_CONTINUATIONS so a pathologically
          // long answer can't spin forever (it then ends as stopReason
          // "length", same as before this fix). Only fires for text
          // truncation: a length cut with tool calls present takes the normal
          // tool path below.
          //
          // Guard: never resume a turn whose reasoning was cut off mid-stream.
          // A thinking block only carries its provider signature once the
          // block completes; a length cut during thinking drains an UNSIGNED
          // reasoning block (see src/model/stream.ts). Replaying an unsigned
          // thinking block as the trailing assistant message is exactly what
          // Anthropic rejects ("thinking blocks in the latest assistant
          // message cannot be modified" — src/model/inbound-fit.ts). In that
          // case fall through to `break` and surface stopReason "length"; the
          // user re-prompts and the model starts a fresh, fully-signed turn.
          if (canResumeFromLength(lastFinishReason, lengthContinuations, response.content)) {
            lengthContinuations += 1;
            // Seed history with the partial assistant text so the next call
            // continues from where it stopped. `normalizeForReplay` fixes the
            // stream→prompt shape, same as the tool path below.
            //
            // Provider note: this relies on assistant-message *prefill
            // continuation* — a trailing assistant message is the turn to
            // continue. That's Anthropic semantics (the configured default
            // and the model this fix was written against). OpenAI/Google
            // instead treat a trailing assistant message as context and start
            // a fresh turn, which `resumingFromLength` would then glue on with
            // no separator — a mildly disjoint resume, still bounded by
            // MAX_LENGTH_CONTINUATIONS and no worse than a crash. We don't gate
            // by provider here on purpose: this engine is provider-agnostic
            // (provider-specific replay lives in the runtime hook, e.g.
            // applyReasoningReplayPolicy). If a non-Anthropic model ever
            // becomes a default, thread a `supportsAssistantPrefillContinuation`
            // capability through EngineConfig and gate on it rather than
            // string-matching the provider in here.
            history.push({ role: "assistant", content: normalizeForReplay(response.content) });
            resumingFromLength = true;
            this.events.emit({
              type: "context.length_continuation",
              data: { runId, continuation: lengthContinuations },
            });
            iteration++;
            continue;
          }
          break; // Model is done
        }

        // 4. Append assistant message to history.
        // `normalizeForReplay` handles the stream→prompt shape mismatches
        // (tool-call input string→object, providerMetadata→providerOptions
        // on every content type). See src/model/inbound-fit.ts.
        const historyContent = normalizeForReplay(response.content);
        history.push({ role: "assistant", content: historyContent });

        // 5. Execute tools in PARALLEL (sync + task-augmented concurrently, §13)
        const toolExecContext: ToolExecContext = {
          config,
          runId,
          toolAnnotations,
          connectorSkillCandidates,
          injectedConnectorSkills,
          toolSchemaMap,
          promotedLastUsed,
          bumpUseCounter,
          supervisor,
        };
        const toolResults = await this.executeToolCallsBounded(toolCalls, toolExecContext);

        // Build result arrays from parallel results. `modelOutput` is the
        // already-bounded text the model sees (computed once, during execution,
        // and persisted on tool.done) — so the live prompt and the replayed
        // prompt carry the identical bounded result.
        const { toolResultParts, toolCallRecords } = buildToolResults(toolResults);
        allToolCalls.push(...toolCallRecords);

        // 6. Feed results back as tool message
        history.push({ role: "tool", content: toolResultParts });

        iteration++;
      }
    } catch (err) {
      this.events.emit({ type: "run.error", data: buildRunErrorData(runId, err) });
      throw err;
    } finally {
      unregisterToolControls?.();
    }

    const totalMs = Math.round(performance.now() - runStart);
    return this.finishRun({
      runId,
      iteration,
      maxIter,
      lastFinishReason,
      totalMs,
      output,
      allToolCalls,
      cumulativeUsage,
      cumulativeLlmMs,
    });
  }

  /**
   * Emit `run.done` and assemble the EngineResult: the run-level stop reason
   * (iteration cap first, then the model-driven exit) and the reported
   * iteration count (which includes the in-progress iteration when the loop
   * exited before the cap).
   */
  private finishRun(params: {
    runId: string;
    iteration: number;
    maxIter: number;
    lastFinishReason: FinishReason | undefined;
    totalMs: number;
    output: string;
    allToolCalls: ToolCallRecord[];
    cumulativeUsage: TokenUsage;
    cumulativeLlmMs: number;
  }): EngineResult {
    const {
      runId,
      iteration,
      maxIter,
      lastFinishReason,
      totalMs,
      output,
      allToolCalls,
      cumulativeUsage,
      cumulativeLlmMs,
    } = params;
    const stopReason: StopReason =
      iteration >= maxIter ? "max_iterations" : deriveStopReason(lastFinishReason);
    const reportedIterations = iteration + (iteration < maxIter ? 1 : 0);
    this.events.emit({
      type: "run.done",
      data: {
        runId,
        stopReason,
        iterations: reportedIterations,
        totalMs,
      },
    });

    return {
      output,
      toolCalls: allToolCalls,
      iterations: reportedIterations,
      usage: cumulativeUsage,
      llmMs: cumulativeLlmMs,
      stopReason,
      ...(lastFinishReason !== undefined ? { finishReason: lastFinishReason } : {}),
    };
  }

  /**
   * Emit the run-scope telemetry the runtime pre-computed (Phase 2:
   * skills.loaded and context.assembled). Tied to the same `runId` as
   * `run.start` so the conversation log records what the prompt looked like for
   * this turn.
   */
  private emitRunPromptMetadata(runId: string, config: EngineConfig): void {
    if (config.runMetadata?.skillsLoaded) {
      this.events.emit({
        type: "skills.loaded",
        data: {
          runId,
          skills: config.runMetadata.skillsLoaded.skills,
          totalTokens: config.runMetadata.skillsLoaded.totalTokens,
        },
      });
    }
    if (config.runMetadata?.contextAssembled) {
      this.events.emit({
        type: "context.assembled",
        data: {
          runId,
          sources: config.runMetadata.contextAssembled.sources,
          excluded: config.runMetadata.contextAssembled.excluded,
          totalTokens: config.runMetadata.contextAssembled.totalTokens,
          ...(config.runMetadata.contextAssembled.modelMaxContext !== undefined
            ? { modelMaxContext: config.runMetadata.contextAssembled.modelMaxContext }
            : {}),
          ...(config.runMetadata.contextAssembled.headroomTokens !== undefined
            ? { headroomTokens: config.runMetadata.contextAssembled.headroomTokens }
            : {}),
        },
      });
    }
  }

  /**
   * Build the per-iteration model toolset and name→schema lookup. Filters out
   * any tool the supervisor has tripped this run: removing the tool from the
   * model's toolset is more reliable than telling the model "do not call this
   * tool" via prose — the model literally can't call a tool that isn't in its
   * list. Other tools remain available so the run can recover.
   */
  private buildIterationTools(
    directTools: ToolSchema[],
    supervisor: RunSupervisor,
  ): { modelTools: LanguageModelV3FunctionTool[]; toolSchemaMap: Map<string, ToolSchema> } {
    const trippedSet = new Set(supervisor.snapshot().trippedTools);
    const usableDirectTools =
      trippedSet.size === 0 ? directTools : directTools.filter((t) => !trippedSet.has(t.name));
    const modelTools: LanguageModelV3FunctionTool[] = usableDirectTools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      inputSchema: toolSchemaForLlm(t.inputSchema, t.name) as JSONSchema7,
    }));

    const toolSchemaMap = new Map<string, ToolSchema>();
    for (const t of usableDirectTools) {
      toolSchemaMap.set(t.name, t);
    }

    return { modelTools, toolSchemaMap };
  }

  /**
   * Backstop for the active-tool cap: evict LRU agent-promoted entries until the
   * set fits `maxActiveTools`. Initial tools are exempt because they're not in
   * `promotedLastUsed`. Defensive guard: if the just-added tool would be its own
   * eviction victim (only possible when initial tools alone already exceed the
   * cap, so promotedLastUsed has only this one entry), break out. Cap is "soft"
   * in that pathological config — the alternative would be silently undoing the
   * agent's intentional promotion, which is worse than letting the cap stretch
   * by one.
   */
  private evictPromotedToolsToCap(
    runId: string,
    directTools: ToolSchema[],
    directToolNames: Set<string>,
    promotedLastUsed: Map<string, number>,
    maxActiveTools: number,
    justAddedToolName: string,
  ): void {
    while (directTools.length > maxActiveTools && promotedLastUsed.size > 0) {
      let oldestName: string | null = null;
      let oldestStamp = Number.POSITIVE_INFINITY;
      for (const [name, stamp] of promotedLastUsed) {
        if (stamp < oldestStamp) {
          oldestStamp = stamp;
          oldestName = name;
        }
      }
      if (!oldestName || oldestName === justAddedToolName) break;
      const idx = directTools.findIndex((t) => t.name === oldestName);
      if (idx >= 0) directTools.splice(idx, 1);
      directToolNames.delete(oldestName);
      promotedLastUsed.delete(oldestName);
      this.events.emit({
        type: "tool.released",
        data: { runId, toolName: oldestName, reason: "evicted" },
      });
    }
  }

  /**
   * Call the model once, recovering from a single provider-reported
   * context-window overflow. The pre-flight `resolveMessageBudget` should make
   * this rare; when it fires, we re-window with the hook's own
   * `overflowAttempt`-driven scaling (typically halves the budget) and retry
   * once. A second overflow propagates the original error so the UI can surface
   * a clear "conversation too long" message rather than silently looping.
   */
  private async callModelWithOverflowRecovery(
    callOnce: (msgs: LanguageModelV3Message[]) => Promise<StreamResult>,
    initialMessages: LanguageModelV3Message[],
    runTransform: (attempt: number) => LanguageModelV3Message[],
    config: EngineConfig,
    runId: string,
  ): Promise<StreamResult> {
    let callMessages = initialMessages;
    let overflowAttempt = 0;
    while (true) {
      try {
        return await callOnce(callMessages);
      } catch (err) {
        if (
          overflowAttempt === 0 &&
          isContextOverflowError(err) &&
          config.hooks?.transformContext
        ) {
          overflowAttempt = 1;
          const previousMessageCount = callMessages.length;
          const errorMessage = err instanceof Error ? err.message : String(err);
          // Always-on stderr line so a frequency uptick is visible in
          // operator logs without flipping a debug flag. Recovery
          // firing means the pre-flight budget composition disagreed
          // with the provider's tokenizer — actionable signal for
          // tuning DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS or the
          // estimator. Per-conversation correlation via runId; the
          // aggregate is what drives action.
          log.warn(
            `[engine] context overflow recovery runId=${runId} attempt=${overflowAttempt} previousMessages=${previousMessageCount} model=${config.model} error="${errorMessage}"`,
          );
          this.events.emit({
            type: "context.overflow_recovery",
            data: {
              runId,
              attempt: overflowAttempt,
              previousMessageCount,
              errorMessage,
            },
          });
          callMessages = sanitizeMessages(runTransform(overflowAttempt));
          continue;
        }
        // Terminal LLM failure: the call threw, in-call retry is exhausted,
        // and it's neither a recoverable overflow nor a user cancellation.
        // Emit the observe-only error fact (for the LLM error-rate metric)
        // before re-throwing — the error still propagates and ends the run.
        // Aborts are excluded: a cancellation isn't a provider failure and
        // must not inflate the error rate.
        if (!config.signal?.aborted) {
          this.events.emit({
            type: "llm.error",
            data: { runId, model: config.model },
          });
        }
        throw err;
      }
    }
  }

  /**
   * Append this turn's assistant text to the running output, emitting the
   * inter-turn separator (`\n\n`) when needed. When this turn is the resumption
   * of a length-truncated one (`resumingFromLength`), stitch directly onto the
   * partial with no separator — the model is continuing mid-thought, so a blank
   * line would inject a false break. Returns the new output; does not consume
   * the resume flag.
   */
  private accumulateAssistantText(
    currentOutput: string,
    content: LanguageModelV3Content[],
    resumingFromLength: boolean,
    runId: string,
  ): string {
    let output = currentOutput;
    for (const block of content) {
      if (block.type === "text") {
        if (
          !resumingFromLength &&
          output.length > 0 &&
          !output.endsWith("\n") &&
          block.text.length > 0
        ) {
          output += "\n\n";
          this.events.emit({ type: "text.delta", data: { runId, text: "\n\n" } });
        }
        output += block.text;
      }
    }
    return output;
  }

  /**
   * Surface-once connector-skill overlays whose tool-affinity matches this call.
   * On the first call to a matching tool, emit `connector.skill.injected` — the
   * reconstructor turns it into a synthetic history message that rides the cached
   * history from the next turn (never the system prefix). Deduped across runs
   * (`injected` is seeded from history) and within this run. Synchronous between
   * the has-check and the add — no await — so parallel tool calls in the
   * iteration's `Promise.all` can't both pass the check and double-inject the
   * same overlay. Mutates `injected`.
   */
  private injectConnectorSkillOverlays(
    runId: string,
    toolName: string,
    candidates: ConnectorSkillCandidate[],
    injected: Set<string>,
  ): void {
    for (const candidate of candidates) {
      if (injected.has(candidate.name)) continue;
      if (!candidate.toolAffinity.some((p) => toolMatches(toolName, p))) continue;
      injected.add(candidate.name);
      this.events.emit({
        type: "connector.skill.injected",
        data: {
          runId,
          toolName,
          skillName: candidate.name,
          skillBody: candidate.body,
          scope: candidate.scope,
        },
      });
    }
  }

  /**
   * Emit `tool.progress` when a tool result was bounded for model context.
   * `outputText` (full) is persisted for the UI and the record; `modelOutput`
   * (bounded) is what enters the prompt. The message differs for inline-UI
   * results (pointer) vs. persisted results. No-op when the result was not
   * bounded.
   */
  private emitToolResultBoundedProgress(
    bounded: boolean,
    runId: string,
    id: string,
    resourceUri: string | undefined,
    outputText: string,
    modelOutput: string,
  ): void {
    if (!bounded) return;
    this.events.emit({
      type: "tool.progress",
      data: {
        runId,
        id,
        message: resourceUri
          ? `Tool result bounded for model context (${outputText.length.toLocaleString()} chars → pointer). Full result rendered in inline UI.`
          : `Tool result bounded for model context (${outputText.length.toLocaleString()} chars → ${modelOutput.length.toLocaleString()}). Full result persisted for the UI.`,
      },
    });
  }

  /**
   * Execute one iteration's tool calls, grouped by source and bounded within
   * each group. See {@link MAX_PARALLEL_TOOL_CALLS_PER_SOURCE_PER_RUN} for the
   * scope this does and does not enforce.
   *
   * The grouping key is the source prefix `ToolRegistry.execute` routes on — the
   * same first-`__` split every dispatch door performs, though each hand-rolls
   * it rather than sharing one function, so the correspondence is CONVENTION,
   * not enforcement: changing the decomposition means changing every site, or
   * this grouping silently desyncs from the registry's routing. The
   * correspondence is what makes the bound meaningful — one group is exactly one
   * `ToolSource`, so the thing bounded is the thing that owns the connection.
   *
   * Calls to different sources still go out together; only depth against any one
   * source is capped. Results are written by index, so `buildToolResults`, which
   * pairs positionally, is unaffected.
   *
   * In-process sources are bounded too. Every `nb__*` tool shares the `nb` key,
   * so the cap covers 6 concurrent `nb__*` calls of any kind — including, but not
   * limited to, `nb__delegate`.
   */
  private async executeToolCallsBounded(
    toolCalls: LanguageModelV3ToolCall[],
    ctx: ToolExecContext,
  ): Promise<ToolExecResult[]> {
    const results = new Array<ToolExecResult>(toolCalls.length);
    const bySource = new Map<string, number[]>();
    for (let i = 0; i < toolCalls.length; i++) {
      // Passing the raw wire name: `splitInnerToolName` documents its input as
      // already stripped of any `ws_<id>-` prefix, which holds here because that
      // form is rejected at the door before a call reaches the engine.
      const { sourcePrefix } = splitInnerToolName(
        (toolCalls[i] as LanguageModelV3ToolCall).toolName,
      );
      const group = bySource.get(sourcePrefix);
      if (group) group.push(i);
      else bySource.set(sourcePrefix, [i]);
    }

    await Promise.all(
      [...bySource.values()].map((indices) =>
        mapWithConcurrency(
          indices,
          MAX_PARALLEL_TOOL_CALLS_PER_SOURCE_PER_RUN,
          async (callIndex) => {
            // `executeToolCall` already contains its own failures (it returns an
            // error result rather than throwing for tool-level problems), so no
            // per-item try/catch is needed to keep siblings running.
            results[callIndex] = await this.executeToolCall(
              toolCalls[callIndex] as LanguageModelV3ToolCall,
              ctx,
            );
          },
        ),
      ),
    );

    return results;
  }

  /**
   * Run one tool call end-to-end: gate (beforeToolCall) → coerce/validate →
   * execute → bound → afterToolCall → supervisor → emit. Returns the record the
   * loop needs to build history and telemetry. Called concurrently (up to the
   * per-source cap) from the iteration's bounded dispatch above.
   */
  private async executeToolCall(
    toolCall: LanguageModelV3ToolCall,
    ctx: ToolExecContext,
  ): Promise<ToolExecResult> {
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = parseToolCallInput(toolCall.input);
    } catch {
      // The model streamed a tool-call `input` that isn't valid JSON (e.g. a
      // stray comma). Surface it as an invalid-input tool result — the same
      // shape a schema-validation failure produces — so the model can correct
      // on the next iteration, rather than throwing and aborting the whole run.
      return {
        toolCall,
        gatedCall: { id: toolCall.toolCallId, name: toolCall.toolName, input: {} },
        result: {
          content: textContent("Invalid tool input: arguments were not valid JSON."),
          isError: true,
        } as ToolResult,
        ms: 0,
      };
    }

    const gatedCall = ctx.config.hooks?.beforeToolCall
      ? await ctx.config.hooks.beforeToolCall({
          id: toolCall.toolCallId,
          name: toolCall.toolName,
          input: parsedInput,
        })
      : { id: toolCall.toolCallId, name: toolCall.toolName, input: parsedInput };

    if (gatedCall === null) {
      return {
        toolCall,
        gatedCall: {
          id: toolCall.toolCallId,
          name: toolCall.toolName,
          input: parsedInput,
        },
        result: {
          content: textContent("Tool call was denied by policy."),
          isError: true,
        } as ToolResult,
        ms: 0,
      };
    }

    // Extract UI resourceUri from tool annotations if present
    const ann = ctx.toolAnnotations.get(gatedCall.name);
    const uiMeta = ann?.ui as Record<string, unknown> | undefined;
    const resourceUri = typeof uiMeta?.resourceUri === "string" ? uiMeta.resourceUri : undefined;

    // tool.start fires with the *pre-coercion* input on purpose:
    // audit/telemetry should see the raw model emission so we can
    // observe when models string-encode nested objects (the very
    // misbehavior coerceInputForSchema below recovers from). Do
    // not move this emit after the coerce step.
    this.events.emit({
      type: "tool.start",
      data: {
        runId: ctx.runId,
        name: gatedCall.name,
        id: gatedCall.id,
        resourceUri,
        input: gatedCall.input,
      },
    });

    this.injectConnectorSkillOverlays(
      ctx.runId,
      gatedCall.name,
      ctx.connectorSkillCandidates,
      ctx.injectedConnectorSkills,
    );

    const start = performance.now();

    // Validate + coerce tool input against the declared schema before execution.
    const toolSchema = ctx.toolSchemaMap.get(gatedCall.name);
    const coercion = coerceAndValidateToolInput(gatedCall.input, toolSchema);
    gatedCall.input = coercion.input;
    let result: ToolResult | undefined = coercion.errorResult;

    if (!result) {
      try {
        // Forward the run's AbortSignal so task-augmented MCP tools
        // propagate cancellation via tasks/cancel and inline tools
        // abort their in-flight RPC. Identity flows through
        // AsyncLocalStorage (`runWithRequestContext`); no principal
        // argument threads through the call.
        result = await this.tools.execute(gatedCall, ctx.config.signal);
      } catch (err) {
        result = {
          content: textContent(err instanceof Error ? err.message : String(err)),
          isError: true,
        };
      }
    }

    // LRU refresh: a promoted tool that's actively being called
    // moves to the back of the eviction queue. Initial tools aren't
    // in the map and are exempt from eviction either way.
    if (ctx.promotedLastUsed.has(gatedCall.name)) {
      ctx.promotedLastUsed.set(gatedCall.name, ctx.bumpUseCounter());
    }

    // Guard: reject oversized tool results before event emission or history accumulation
    result = enforceMaxToolResultSize(result, ctx.config.maxToolResultSize);

    const ms = performance.now() - start;

    const hookedResult = ctx.config.hooks?.afterToolCall
      ? await ctx.config.hooks.afterToolCall(gatedCall, result)
      : result;

    // Supervisor sees the post-hook, post-A.3-normalization result.
    // On a trip, the replacement directive flows downstream in place
    // of the original tool result. The tripped tool is filtered out
    // of `modelTools` on subsequent iterations (see buildIterationTools),
    // so the model can't call it again regardless of what the directive says.
    const verdict = ctx.supervisor.observe(gatedCall, hookedResult);
    const finalResult = verdict.type === "synth" ? verdict.replacement : hookedResult;

    // Extract text output for persistence. The full structured result
    // is only attached when there's a resourceUri (inline UI), but the
    // text output is always needed for conversation history reconstruction.
    const outputText = extractTextForModel(finalResult.content);

    // Bound the text the MODEL sees. `outputText` (full) is persisted
    // for the UI and the record; `modelOutput` (bounded) is what enters
    // the prompt — both on this live turn AND on every replay. Computing
    // it once here and persisting it keeps the live view and the
    // replayed view byte-identical. See boundToolResultForModel.
    const modelOutput = boundToolResultForModel(outputText, {
      hasUiResource: !!resourceUri,
    });
    const bounded = modelOutput !== outputText;
    this.emitToolResultBoundedProgress(
      bounded,
      ctx.runId,
      gatedCall.id,
      resourceUri,
      outputText,
      modelOutput,
    );

    // Per-call resource_link blocks (MCP 2025-11-25). Distinct from the
    // static `resourceUri` tool annotation used for inline UI binding —
    // resource_link points at a file/resource the client should fetch.
    const resourceLinks = extractResourceLinks(finalResult.content);

    this.events.emit({
      type: "tool.done",
      data: buildToolDoneData({
        runId: ctx.runId,
        name: gatedCall.name,
        id: gatedCall.id,
        finalResult,
        ms,
        resourceUri,
        outputText,
        bounded,
        modelOutput,
        resourceLinks,
        verdict,
      }),
    });

    return {
      toolCall,
      gatedCall,
      result: finalResult,
      ms,
      resourceUri,
      resourceLinks,
      modelOutput,
    };
  }
}
