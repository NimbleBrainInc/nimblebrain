import type {
  JSONSchema7,
  LanguageModelV3,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
  SharedV3ProviderOptions,
} from "@ai-sdk/provider";
import { MAX_ITERATIONS, MAX_TOOL_RESULT_CHARS } from "../limits.ts";
import { getProviderFromModel, supportsEnabledThinking } from "../model/catalog.ts";
import { normalizeForReplay } from "../model/inbound-fit.ts";
import { callModel, type StreamResult } from "../model/stream.ts";
import { coerceInputForSchema } from "../tools/coerce-input.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import type { TokenUsage } from "../usage/types.ts";
import { addUsage, emptyUsage } from "../usage/types.ts";
import {
  estimateContentSize,
  extractResourceLinks,
  extractTextForModel,
  textContent,
} from "./content-helpers.ts";
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

const CACHE_CONTROL_EPHEMERAL = {
  anthropic: { cacheControl: { type: "ephemeral" } },
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

    try {
      while (iteration < maxIter) {
        const modelTools: LanguageModelV3FunctionTool[] = directTools.map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          inputSchema: toolSchemaForLlm(t.inputSchema, t.name) as JSONSchema7,
        }));

        const toolSchemaMap = new Map<string, ToolSchema>();
        for (const t of directTools) {
          toolSchemaMap.set(t.name, t);
        }

        // 1. Apply context/prompt hooks and call LLM
        const windowed = config.hooks?.transformContext
          ? config.hooks.transformContext([...history])
          : history;
        // Sanitize: filter out empty text content blocks that the API rejects
        const callMessages = sanitizeMessages(windowed);
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

        // One-shot nudge after the supervisor tripped on the previous iteration.
        // Pairs with the synth-stop replacement so the directive is unambiguous:
        // the tool result tells the model what to say, the system-prompt nudge
        // forecloses further tool calls.
        if (supervisor.needsPromptNudge()) {
          callPrompt +=
            "\n\n[IMPORTANT: A tool was detected to be in a loop and has been disabled " +
            "for the remainder of this run. Do NOT call any more tools. Produce a final " +
            "response now per the instructions in the last tool result.]";
          supervisor.consumeNudge();
        }

        const callProviderOptions = buildThinkingProviderOptions(config.model, config.thinking);

        const llmStart = performance.now();
        const response: StreamResult = await withRetry(() =>
          callModel(
            this.model,
            {
              prompt: [
                {
                  role: "system",
                  content: callPrompt,
                  providerOptions: {
                    anthropic: { cacheControl: { type: "ephemeral" } },
                  },
                },
                ...addCacheBreakpoint(callMessages),
              ],
              tools: modelTools,
              maxOutputTokens: config.maxOutputTokens,
              ...(Object.keys(callProviderOptions).length > 0
                ? { providerOptions: callProviderOptions }
                : {}),
            },
            (text) => this.events.emit({ type: "text.delta", data: { runId, text } }),
            (text) => this.events.emit({ type: "reasoning.delta", data: { runId, text } }),
            (id, name) => this.events.emit({ type: "tool.preparing", data: { runId, id, name } }),
            (id) => this.events.emit({ type: "tool.preparing.done", data: { runId, id } }),
          ),
        );
        const llmMs = Math.round(performance.now() - llmStart);

        // Accumulate text output (add newline between turns if needed)
        for (const block of response.content) {
          if (block.type === "text") {
            if (output.length > 0 && !output.endsWith("\n") && block.text.length > 0) {
              output += "\n\n";
              this.events.emit({ type: "text.delta", data: { runId, text: "\n\n" } });
            }
            output += block.text;
          }
        }

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
                // abort their in-flight RPC. principalId is the conversation
                // owner's id — used by member-scoped MCP bundles to route
                // to the right per-principal source. Workspace-scoped
                // sources ignore it.
                result = await this.tools.execute(gatedCall, config.signal, config.principalId);
              } catch (err) {
                result = {
                  content: textContent(err instanceof Error ? err.message : String(err)),
                  isError: true,
                };
              }
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
            // of the original — the model sees the directive in its tool
            // message and the engine appends a system-prompt nudge on the
            // next iteration via `needsPromptNudge()`.
            const verdict = supervisor.observe(gatedCall, hookedResult);
            const finalResult = verdict.type === "synth" ? verdict.replacement : hookedResult;

            // Extract text output for persistence. The full structured result
            // is only attached when there's a resourceUri (inline UI), but the
            // text output is always needed for conversation history reconstruction.
            const outputText = extractTextForModel(finalResult.content);

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

            return { toolCall, gatedCall, result: finalResult, ms, resourceUri, resourceLinks };
          }),
        );

        // Build result arrays from parallel results.
        // For tools with a UI resource, cap the content sent back to the LLM
        // to avoid token explosion from large binary payloads (e.g., base64 PNGs).
        // The full result is still available to the inline UI via tool.done event.
        const toolResultParts: LanguageModelV3ToolResultPart[] = [];

        for (const {
          toolCall,
          gatedCall,
          result,
          ms,
          resourceUri: uri,
          resourceLinks: links,
        } of toolResults) {
          let llmText = extractTextForModel(result.content);

          if (uri && llmText.length > MAX_TOOL_RESULT_CHARS) {
            // Tool has inline UI — the UI handles display.
            // Give the LLM a summary instead of the raw binary payload.
            this.events.emit({
              type: "tool.progress",
              data: {
                runId,
                id: toolCall.toolCallId,
                message: `Tool result truncated for LLM (${llmText.length.toLocaleString()} chars → summary). Full result rendered in inline UI.`,
              },
            });
            llmText = `[Tool completed successfully. Result (${llmText.length.toLocaleString()} chars) is displayed in the inline UI. Do not ask the user to view it separately — it is already visible.]`;
          } else if (llmText.length > MAX_TOOL_RESULT_CHARS) {
            // No UI resource — truncate with a warning.
            llmText =
              llmText.slice(0, MAX_TOOL_RESULT_CHARS) +
              `\n\n[Result truncated: ${llmText.length.toLocaleString()} chars exceeded ${MAX_TOOL_RESULT_CHARS.toLocaleString()} char limit.]`;
          }

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

          if (
            gatedCall.name === "nb__search" &&
            !result.isError &&
            gatedCall.input.scope === "tools"
          ) {
            const structured = result.structuredContent as
              | { tools?: Array<{ name?: string }> }
              | undefined;
            for (const { name } of structured?.tools ?? []) {
              if (!name) continue;
              if (directToolNames.has(name)) continue;
              const schema = allToolSchemaMap.get(name);
              if (!schema) continue;
              if (schema.annotations?.["ai.nimblebrain/internal"]) continue;
              directTools.push(schema);
              directToolNames.add(name);
            }
          }
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
