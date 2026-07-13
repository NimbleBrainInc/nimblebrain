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
import { getProviderFromModel, supportsEnabledThinking } from "../model/catalog.ts";
import { normalizeForReplay } from "../model/inbound-fit.ts";
import { callModel, type StreamResult } from "../model/stream.ts";
import { log } from "../observability/log.ts";
import { toolMatches } from "../skills/select.ts";
import { coerceInputForSchema } from "../tools/coerce-input.ts";
import { bareToolName } from "../tools/namespace.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import type { TokenUsage } from "../usage/types.ts";
import { addUsage, emptyUsage, tokenUsageFromV3 } from "../usage/types.ts";
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
  type EngineConfig,
  type EngineResult,
  type EventSink,
  type FinishReason,
  type ResolvedThinking,
  type StopReason,
  type ToolCall,
  type ToolCallRecord,
  type ToolResult,
  type ToolRouter,
  type ToolSchema,
} from "./types.ts";

/**
 * Map a thinking budget (tokens) to an Anthropic effort tier. Used when
 * translating the platform's `enabled`-mode budget to the adaptive+effort
 * shape required by adaptive-only models like Opus 4.7. Bands are
 * calibrated against `safeThinkingBudget` output so the effort tier
 * scales with `maxOutputTokens`:
 *   maxOutputTokens 8K   → budget   4096 → "low"
 *   maxOutputTokens 16K  → budget  12288 → "medium"
 *   maxOutputTokens 32K  → budget  28672 → "high"
 *   maxOutputTokens 128K → budget 123904 → "max"
 */
function budgetToEffort(budget: number): "low" | "medium" | "high" | "max" {
  if (budget <= 4096) return "low";
  if (budget <= 16384) return "medium";
  if (budget <= 32768) return "high";
  return "max";
}

/**
 * Build the `providerOptions.anthropic` thinking shape for the resolved config.
 * Adaptive-only models (e.g. Opus 4.7) reject `thinking.type=enabled` outright,
 * and drop `budgetTokens` on adaptive; both are translated to
 * `thinking.type=adaptive` plus a top-level `effort` mapped from the budget so
 * the operator's intended cap actually constrains thinking.
 */
function buildAnthropicThinkingOptions(
  model: string,
  thinking: ResolvedThinking,
): SharedV3ProviderOptions {
  if (thinking.mode === "off") {
    return { anthropic: { thinking: { type: "disabled" } } };
  }
  const adaptiveOnly = !supportsEnabledThinking(model);
  if (thinking.mode === "adaptive") {
    // Adaptive with an explicit budget on adaptive-only models maps to
    // effort so the operator's intended cap actually constrains thinking
    // (the SDK drops budgetTokens on adaptive otherwise). For models that
    // accept enabled, adaptive is left bare — the model decides.
    if (adaptiveOnly && thinking.budgetTokens != null) {
      return {
        anthropic: {
          thinking: { type: "adaptive" },
          effort: budgetToEffort(thinking.budgetTokens),
        },
      };
    }
    return { anthropic: { thinking: { type: "adaptive" } } };
  }
  // mode === "enabled"
  if (adaptiveOnly) {
    // Anthropic rejects `thinking.type=enabled` for these models with a
    // specific error pointing at `output_config.effort`. Translate the
    // platform's enabled+budget into adaptive+effort here so the
    // resolver stays provider-neutral.
    return {
      anthropic: {
        thinking: { type: "adaptive" },
        ...(thinking.budgetTokens != null ? { effort: budgetToEffort(thinking.budgetTokens) } : {}),
      },
    };
  }
  return {
    anthropic: {
      thinking: {
        type: "enabled",
        ...(thinking.budgetTokens != null ? { budgetTokens: thinking.budgetTokens } : {}),
      },
    },
  };
}

/**
 * Translate the platform's provider-neutral thinking config into the
 * call's `providerOptions` shape. Each provider has its own option name
 * and discriminated-union shape; we keep them confined to this helper
 * so adding a new provider doesn't ripple through the engine loop.
 *
 * Today: Anthropic only. OpenAI o-series (`reasoningEffort`) and
 * Google Gemini 2.5 (`thinkingConfig`) are TODO and ignored — those
 * providers fall back to their own defaults until wired in.
 */
function buildThinkingProviderOptions(
  model: string,
  thinking: ResolvedThinking | undefined,
): SharedV3ProviderOptions {
  if (!thinking) return {};
  if (getProviderFromModel(model) === "anthropic") {
    return buildAnthropicThinkingOptions(model, thinking);
  }
  // openai / google: not yet wired. The provider falls back to its own
  // default behavior. Tracked for follow-up.
  return {};
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
    if (directTools.length > maxActiveTools) {
      // Operator-facing: initial tool set already exceeds the per-run cap,
      // so the cap can't be enforced strictly for agent-driven additions.
      // Surface the misconfiguration once at run start; behavior degrades
      // to "cap is soft, agent additions stick on top." See addTool below.
      log.warn(
        `[engine] initial tools (${directTools.length}) exceed maxActiveTools (${maxActiveTools}); ` +
          `cap will be soft for this run. Reduce the initial tool set or raise maxActiveTools.`,
      );
    }

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
        if (schema.annotations?.["ai.nimblebrain/internal"]) {
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
        // Match the BARE name: Stage 2 surfaces system tools as
        // `ws_<id>-nb__<tool>`, so a raw `startsWith("nb__")` would let a
        // namespaced system tool be released.
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

        const callProviderOptions = buildThinkingProviderOptions(config.model, config.thinking);

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
        const toolResults = await Promise.all(
          toolCalls.map((toolCall) => this.executeToolCall(toolCall, toolExecContext)),
        );

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
   * Run one tool call end-to-end: gate (beforeToolCall) → coerce/validate →
   * execute → bound → afterToolCall → supervisor → emit. Returns the record the
   * loop needs to build history and telemetry. Called concurrently (one per tool
   * call) inside the iteration's `Promise.all`.
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
