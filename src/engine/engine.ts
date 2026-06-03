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
import { log } from "../cli/log.ts";
import { DEFAULT_MAX_DIRECT_TOOLS, MAX_ITERATIONS, MAX_LENGTH_CONTINUATIONS } from "../limits.ts";
import { getProviderFromModel, supportsEnabledThinking } from "../model/catalog.ts";
import { normalizeForReplay } from "../model/inbound-fit.ts";
import { callModel, type StreamResult } from "../model/stream.ts";
import { coerceInputForSchema } from "../tools/coerce-input.ts";
import { bareToolName } from "../tools/namespace.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import type { TokenUsage } from "../usage/types.ts";
import { addUsage, emptyUsage } from "../usage/types.ts";
import {
  boundToolResultForModel,
  estimateContentSize,
  extractResourceLinks,
  extractTextForModel,
  textContent,
} from "./content-helpers.ts";
import { isContextOverflowError } from "./context-overflow.ts";
import { withRetry } from "./retry.ts";
import { createRunSupervisor } from "./supervisor.ts";
import { toolSchemaForLlm } from "./tool-schema-for-llm.ts";
import type {
  EngineConfig,
  EngineResult,
  EventSink,
  FinishReason,
  ResolvedThinking,
  StopReason,
  ToolCallRecord,
  ToolResult,
  ToolRouter,
  ToolSchema,
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
 * Translate the platform's provider-neutral thinking config into the
 * call's `providerOptions` shape. Each provider has its own option name
 * and discriminated-union shape; we keep them confined to this helper
 * so adding a new provider doesn't ripple through the engine loop.
 *
 * Today: Anthropic only. OpenAI o-series (`reasoningEffort`) and
 * Google Gemini 2.5 (`thinkingConfig`) are TODO and ignored — those
 * providers fall back to their own defaults until wired in.
 *
 * Adaptive-only models (e.g. Opus 4.7) reject `thinking.type=enabled`
 * outright; for those we emit `thinking.type=adaptive` plus a top-level
 * `effort` mapped from the resolved budget. The AI SDK forwards `effort`
 * as `output_config.effort` and adds the `effort-2025-11-24` beta header.
 */
function buildThinkingProviderOptions(
  model: string,
  thinking: ResolvedThinking | undefined,
): SharedV3ProviderOptions {
  if (!thinking) return {};

  const provider = getProviderFromModel(model);

  if (provider === "anthropic") {
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
          ...(thinking.budgetTokens != null
            ? { effort: budgetToEffort(thinking.budgetTokens) }
            : {}),
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

// 1-hour cache TTL (vs Anthropic's 5-minute default). Agentic runs pause
// between turns far longer than 5 minutes (a user steps away; an automation
// waits on I/O), so a 5-minute prefix lapses constantly and the next turn
// re-WRITES the whole cached prefix at the write rate. A 1-hour TTL keeps the
// prefix alive across those gaps, converting full re-writes into cheap cache
// reads. The 1-hour write rate is 2x base input vs 1.25x for 5-minute, but
// that is paid once per write and is dwarfed by the reads it unlocks.
const CACHE_CONTROL_EPHEMERAL = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
} as const;

/**
 * Add an ephemeral cache breakpoint to the last user message in the
 * conversation. Combined with the breakpoint on the system message, this
 * lets Anthropic cache the stable prefix (system prompt + tools +
 * conversation history up to the last user turn) across agentic iterations.
 *
 * Anthropic allows up to 4 cache breakpoints per request. We use 2:
 *   1. The system prompt (set at the call site)
 *   2. The last user message (set here)
 */
function addCacheBreakpoint(messages: LanguageModelV3Message[]): LanguageModelV3Message[] {
  if (messages.length === 0) return messages;

  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) return messages;

  // Shallow-copy the array and replace the target message with a version
  // that carries providerOptions for cache control.
  const result = [...messages];
  const target = result[lastUserIdx]!;
  result[lastUserIdx] = {
    ...target,
    providerOptions: {
      ...target.providerOptions,
      ...CACHE_CONTROL_EPHEMERAL,
    },
  } as LanguageModelV3Message;

  return result;
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

    let iteration = 0;
    const cumulativeUsage: TokenUsage = emptyUsage();
    let cumulativeLlmMs = 0;
    let output = "";
    const allToolCalls: ToolCallRecord[] = [];
    const runId = crypto.randomUUID();

    // Build tool annotations lookup for UI metadata (resourceUri).
    // Use ALL tools from the router (not just the direct/surfaced subset passed
    // to the LLM) because tiered surfacing may proxy UI-annotated tools.
    const toolAnnotations = new Map<string, Record<string, unknown>>();
    const allRouterTools = await this.tools.availableTools();
    for (const t of allRouterTools) {
      if (t.annotations) toolAnnotations.set(t.name, t.annotations);
    }

    const allToolSchemaMap = new Map<string, ToolSchema>();
    for (const t of allRouterTools) {
      allToolSchemaMap.set(t.name, t);
    }

    const directTools = [...tools];
    const directToolNames = new Set(directTools.map((t) => t.name));
    // LRU bookkeeping for agent-promoted tools. Initial tools (passed in
    // `tools`) are NEVER tracked here, so the eviction loop can never
    // touch them — they're operator-opted-in. Counter is monotonic so
    // smaller stamp = older, regardless of clock skew or test parallelism.
    const promotedLastUsed = new Map<string, number>();
    let useCounter = 0;
    const maxActiveTools = config.maxActiveTools ?? DEFAULT_MAX_DIRECT_TOOLS;
    if (directTools.length > maxActiveTools) {
      // Operator-facing: initial tool set already exceeds the per-run cap,
      // so the cap can't be enforced strictly for agent-driven additions.
      // Surface the misconfiguration once at run start; behavior degrades
      // to "cap is soft, agent additions stick on top." See addTool below.
      console.warn(
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

        // Backstop: cap active tools by evicting LRU agent-promoted entries.
        // Initial tools are exempt because they're not in `promotedLastUsed`.
        // Defensive guard: if the just-added tool would be its own eviction
        // victim (only possible when initial tools alone already exceed the
        // cap, so promotedLastUsed has only this one entry), break out.
        // Cap is "soft" in that pathological config — the alternative would
        // be silently undoing the agent's intentional promotion, which is
        // worse than letting the cap stretch by one.
        while (directTools.length > maxActiveTools && promotedLastUsed.size > 0) {
          let oldestName: string | null = null;
          let oldestStamp = Number.POSITIVE_INFINITY;
          for (const [name, stamp] of promotedLastUsed) {
            if (stamp < oldestStamp) {
              oldestStamp = stamp;
              oldestName = name;
            }
          }
          if (!oldestName || oldestName === toolName) break;
          const idx = directTools.findIndex((t) => t.name === oldestName);
          if (idx >= 0) directTools.splice(idx, 1);
          directToolNames.delete(oldestName);
          promotedLastUsed.delete(oldestName);
          this.events.emit({
            type: "tool.released",
            data: { runId, toolName: oldestName, reason: "evicted" },
          });
        }
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

    // Emit run-scope telemetry the runtime pre-computed (Phase 2: skills.loaded
    // and context.assembled). Tied to the same `runId` as `run.start` so the
    // conversation log records what the prompt looked like for this turn.
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
        if (config.signal?.aborted) {
          throw config.signal.reason instanceof Error
            ? config.signal.reason
            : new DOMException("The operation was aborted.", "AbortError");
        }
        // Filter out any tool the supervisor has tripped this run. Removing
        // the tool from the model's toolset is more reliable than telling
        // the model "do not call this tool" via prose — the model literally
        // can't call a tool that isn't in its list. Other tools remain
        // available so the run can recover.
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
        let callPrompt = config.hooks?.transformPrompt
          ? config.hooks.transformPrompt(systemPrompt)
          : systemPrompt;

        // On the final allowed iteration, tell the model to wrap up instead of
        // starting new tool calls that will never execute.
        if (iteration === maxIter - 1) {
          callPrompt +=
            "\n\n[IMPORTANT: This is your final step. Do NOT call any more tools. " +
            "Summarize what you have accomplished so far and clearly list what " +
            "remains unfinished so the user can continue in a follow-up message.]";
        }

        const callProviderOptions = buildThinkingProviderOptions(config.model, config.thinking);

        const callOnce = (msgs: LanguageModelV3Message[]) =>
          withRetry(
            () =>
              callModel(
                this.model,
                {
                  prompt: [
                    {
                      role: "system",
                      // Same ephemeral 1-hour cache control as the last-user
                      // breakpoint — reuse the const so the TTL lives in one
                      // place. See CACHE_CONTROL_EPHEMERAL.
                      content: callPrompt,
                      providerOptions: CACHE_CONTROL_EPHEMERAL,
                    },
                    ...addCacheBreakpoint(msgs),
                  ],
                  tools: modelTools,
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

        const llmStart = performance.now();
        let response: StreamResult;
        let overflowAttempt = 0;
        while (true) {
          try {
            response = await callOnce(callMessages);
            break;
          } catch (err) {
            // Reactive recovery for provider-reported context-window
            // overflows. The pre-flight `resolveMessageBudget` should make
            // this rare; when it fires, we re-window with the hook's
            // own `overflowAttempt`-driven scaling (typically halves the
            // budget) and retry once. A second overflow propagates the
            // original error so the UI can surface a clear "conversation
            // too long" message rather than silently looping.
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
            throw err;
          }
        }
        const llmMs = Math.round(performance.now() - llmStart);

        // Accumulate text output (add newline between turns if needed).
        // When this turn is the resumption of a length-truncated one, stitch
        // directly onto the partial with no separator — the model is
        // continuing mid-thought, so a blank line would inject a false break.
        for (const block of response.content) {
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
        // Consume the resume flag unconditionally: it must not leak into a
        // later iteration if this resumed turn produced no text block (e.g.
        // tool-call- or reasoning-only), which would wrongly glue a genuinely
        // new turn onto the previous one.
        resumingFromLength = false;

        // Map the AI SDK V3 usage shape into our canonical TokenUsage.
        // V3's `inputTokens.total` is the grand total (noCache+cacheRead+
        // cacheWrite); we preserve that semantics on TokenUsage.inputTokens
        // and surface the cache subsets as siblings. Cost computation
        // subtracts the subsets from the totals — see src/usage/cost.ts.
        const turnUsage: TokenUsage = {
          inputTokens: response.usage.inputTokens.total ?? 0,
          outputTokens: response.usage.outputTokens.total ?? 0,
          cacheReadTokens: response.usage.inputTokens.cacheRead ?? 0,
          cacheWriteTokens: response.usage.inputTokens.cacheWrite ?? 0,
          reasoningTokens: response.usage.outputTokens.reasoning ?? 0,
        };
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
          if (
            lastFinishReason === "length" &&
            lengthContinuations < MAX_LENGTH_CONTINUATIONS &&
            !hasUnsignedReasoning(response.content)
          ) {
            lengthContinuations += 1;
            // Seed history with the partial assistant text so the next call
            // continues from where it stopped (Anthropic resumes an assistant
            // turn when it's the trailing message). `normalizeForReplay`
            // fixes the stream→prompt shape, same as the tool path below.
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
        const toolResults = await Promise.all(
          toolCalls.map(async (toolCall) => {
            const parsedInput = (
              typeof toolCall.input === "string"
                ? JSON.parse(toolCall.input)
                : (toolCall.input ?? {})
            ) as Record<string, unknown>;

            const gatedCall = config.hooks?.beforeToolCall
              ? await config.hooks.beforeToolCall({
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
            const ann = toolAnnotations.get(gatedCall.name);
            const uiMeta = ann?.ui as Record<string, unknown> | undefined;
            const resourceUri =
              typeof uiMeta?.resourceUri === "string" ? uiMeta.resourceUri : undefined;

            // tool.start fires with the *pre-coercion* input on purpose:
            // audit/telemetry should see the raw model emission so we can
            // observe when models string-encode nested objects (the very
            // misbehavior coerceInputForSchema below recovers from). Do
            // not move this emit after the coerce step.
            this.events.emit({
              type: "tool.start",
              data: {
                runId,
                name: gatedCall.name,
                id: gatedCall.id,
                resourceUri,
                input: gatedCall.input,
              },
            });

            const start = performance.now();
            let result: ToolResult | undefined;

            // Validate tool input against declared schema before execution.
            // Coerce first: models occasionally emit nested object/array
            // values as JSON-encoded strings (`{ manifest: "{...}" }`).
            // The coerce pass uses the schema as a parsing oracle to
            // recover those one-level misencodings before validation.
            const toolSchema = toolSchemaMap.get(gatedCall.name);
            if (toolSchema?.inputSchema) {
              const schema = toolSchema.inputSchema as Record<string, unknown>;
              gatedCall.input = coerceInputForSchema(gatedCall.input, schema);
              const validation = validateToolInput(gatedCall.input, schema);
              if (!validation.valid) {
                result = {
                  content: textContent(`Invalid tool input: ${validation.error}`),
                  isError: true,
                };
              }
            }

            if (!result) {
              try {
                // Forward the run's AbortSignal so task-augmented MCP tools
                // propagate cancellation via tasks/cancel and inline tools
                // abort their in-flight RPC. Identity flows through
                // AsyncLocalStorage (`runWithRequestContext`); no principal
                // argument threads through the call.
                result = await this.tools.execute(gatedCall, config.signal);
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
            if (promotedLastUsed.has(gatedCall.name)) {
              promotedLastUsed.set(gatedCall.name, ++useCounter);
            }

            // Guard: reject oversized tool results before event emission or history accumulation
            const maxResultSize = config.maxToolResultSize ?? 1_000_000;
            if (maxResultSize > 0) {
              const resultSize = estimateContentSize(result.content);
              if (resultSize > maxResultSize) {
                result = {
                  content: textContent(
                    `Tool result too large (${resultSize.toLocaleString()} chars, limit: ${maxResultSize.toLocaleString()}). ` +
                      `Ask the user to constrain the query or use pagination.`,
                  ),
                  isError: true,
                };
              }
            }

            const ms = performance.now() - start;

            const hookedResult = config.hooks?.afterToolCall
              ? await config.hooks.afterToolCall(gatedCall, result)
              : result;

            // Supervisor sees the post-hook, post-A.3-normalization result.
            // On a trip, the replacement directive flows downstream in place
            // of the original tool result. The tripped tool is filtered out
            // of `modelTools` on subsequent iterations (see the top of the
            // run loop), so the model can't call it again regardless of
            // what the directive says.
            const verdict = supervisor.observe(gatedCall, hookedResult);
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
            if (bounded) {
              this.events.emit({
                type: "tool.progress",
                data: {
                  runId,
                  id: gatedCall.id,
                  message: resourceUri
                    ? `Tool result bounded for model context (${outputText.length.toLocaleString()} chars → pointer). Full result rendered in inline UI.`
                    : `Tool result bounded for model context (${outputText.length.toLocaleString()} chars → ${modelOutput.length.toLocaleString()}). Full result persisted for the UI.`,
                },
              });
            }

            // Per-call resource_link blocks (MCP 2025-11-25). Distinct from the
            // static `resourceUri` tool annotation used for inline UI binding —
            // resource_link points at a file/resource the client should fetch.
            const resourceLinks = extractResourceLinks(finalResult.content);

            this.events.emit({
              type: "tool.done",
              data: {
                runId,
                name: gatedCall.name,
                id: gatedCall.id,
                ok: !finalResult.isError,
                ms,
                resourceUri,
                output: outputText,
                // Persisted only when it actually differs from `output`, so
                // small results don't carry a duplicate field. Replay falls
                // back to bounding `output` for legacy events without it.
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
              },
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
          }),
        );

        // Build result arrays from parallel results. `modelOutput` is the
        // already-bounded text the model sees (computed once, above, and
        // persisted on tool.done) — so the live prompt and the replayed
        // prompt carry the identical bounded result.
        const toolResultParts: LanguageModelV3ToolResultPart[] = [];

        for (const {
          toolCall,
          result,
          ms,
          resourceUri: uri,
          resourceLinks: links,
          modelOutput,
        } of toolResults) {
          // `modelOutput` is present for every executed tool (bounded once,
          // above). Early-return paths that skip execution (e.g. policy-denied)
          // omit it; bound their small result here so the type stays a string.
          const llmText =
            modelOutput ??
            boundToolResultForModel(extractTextForModel(result.content), { hasUiResource: !!uri });
          allToolCalls.push({
            id: toolCall.toolCallId,
            name: toolCall.toolName,
            input: JSON.parse(toolCall.input) as Record<string, unknown>,
            output: llmText,
            ok: !result.isError,
            ms,
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

        // 6. Feed results back as tool message
        history.push({ role: "tool", content: toolResultParts });

        iteration++;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.events.emit({
        type: "run.error",
        data: {
          runId,
          error: errorMessage,
          type: err instanceof Error ? err.constructor.name : "Error",
        },
      });
      throw err;
    } finally {
      unregisterToolControls?.();
    }

    const stopReason: StopReason =
      iteration >= maxIter ? "max_iterations" : deriveStopReason(lastFinishReason);
    this.events.emit({
      type: "run.done",
      data: {
        runId,
        stopReason,
        iterations: iteration + (iteration < maxIter ? 1 : 0),
        totalMs: Math.round(performance.now() - runStart),
      },
    });

    return {
      output,
      toolCalls: allToolCalls,
      iterations: iteration + (iteration < maxIter ? 1 : 0),
      usage: cumulativeUsage,
      llmMs: cumulativeLlmMs,
      stopReason,
      ...(lastFinishReason !== undefined ? { finishReason: lastFinishReason } : {}),
    };
  }
}
