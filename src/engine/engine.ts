import type {
  JSONSchema7,
  LanguageModelV3,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import { MAX_ITERATIONS, MAX_TOOL_RESULT_CHARS } from "../limits.ts";
import { callModel, type StreamResult } from "../model/stream.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import { estimateContentSize, extractTextForModel, textContent } from "./content-helpers.ts";
import { withRetry } from "./retry.ts";
import { ActiveTaskTracker, getImmediateResponse, type McpTask, pollTask } from "./tasks.ts";
import type {
  EngineConfig,
  EngineResult,
  EventSink,
  ToolCallRecord,
  ToolResult,
  ToolRouter,
  ToolSchema,
} from "./types.ts";

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
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
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

    // Task tracker for cancellation on abort (§13)
    const taskTracker = new ActiveTaskTracker();

    // Wire abort signal to cancel all active tasks
    const onAbort = () => {
      void taskTracker.cancelAll();
    };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    // Translate ToolSchema[] to LanguageModelV3FunctionTool[] for the model call
    const modelTools: LanguageModelV3FunctionTool[] = tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as JSONSchema7,
    }));

    // Build tool schema lookup for input validation (once per run, not per iteration)
    const toolSchemaMap = new Map<string, ToolSchema>();
    for (const t of tools) {
      toolSchemaMap.set(t.name, t);
    }

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

    const runStart = performance.now();

    try {
      while (iteration < maxIter) {
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
            },
            (text) => this.events.emit({ type: "text.delta", data: { runId, text } }),
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

        // Accumulate tokens
        const turnInputTokens = response.usage.inputTokens.total ?? 0;
        const turnOutputTokens = response.usage.outputTokens.total ?? 0;
        const turnCacheReadTokens = response.usage.inputTokens.cacheRead ?? 0;
        const turnCacheCreationTokens = response.usage.inputTokens.cacheWrite ?? 0;
        cumulativeInputTokens += turnInputTokens;
        cumulativeOutputTokens += turnOutputTokens;

        // Record the atomic LLM call fact
        this.events.emit({
          type: "llm.done",
          data: {
            runId,
            model: config.model,
            content: response.content,
            inputTokens: turnInputTokens,
            outputTokens: turnOutputTokens,
            cacheReadTokens: turnCacheReadTokens,
            cacheCreationTokens: turnCacheCreationTokens,
            llmMs,
          },
        });

        // 2. Extract tool calls
        const toolCalls = response.content.filter(
          (b): b is LanguageModelV3ToolCall => b.type === "tool-call",
        );

        if (toolCalls.length === 0) {
          break; // Model is done
        }

        // 4. Append assistant message to history
        // Stream tool-call parts have input as a JSON string, but the prompt format
        // expects input as a parsed object. Convert before adding to history.
        const historyContent = response.content.map((part) => {
          if (part.type === "tool-call" && typeof part.input === "string") {
            try {
              return { ...part, input: JSON.parse(part.input) };
            } catch {
              return { ...part, input: {} };
            }
          }
          return part;
        });
        history.push({ role: "assistant", content: historyContent } as LanguageModelV3Message);

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

            // Validate tool input against declared schema before execution
            const toolSchema = toolSchemaMap.get(gatedCall.name);
            if (toolSchema?.inputSchema) {
              const validation = validateToolInput(
                gatedCall.input,
                toolSchema.inputSchema as Record<string, unknown>,
              );
              if (!validation.valid) {
                result = {
                  content: textContent(`Invalid tool input: ${validation.error}`),
                  isError: true,
                };
              }
            }

            if (!result) {
              try {
                result = await this.tools.execute(gatedCall);
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

            // §13: If the result carries _taskResult, poll the task
            if (result._taskResult) {
              const taskClient = config.taskClientResolver?.(gatedCall.name);
              if (taskClient) {
                const taskMeta = result._taskResult;
                const task: McpTask = {
                  taskId: taskMeta.task.taskId,
                  status: taskMeta.task.status as McpTask["status"],
                  ttl: taskMeta.task.ttl,
                  createdAt: taskMeta.task.createdAt,
                  lastUpdatedAt: taskMeta.task.lastUpdatedAt,
                  pollInterval: taskMeta.task.pollInterval,
                  statusMessage: taskMeta.task.statusMessage,
                };

                // Check for immediate response (model context while polling)
                const immediateResponse = getImmediateResponse({
                  task,
                  _meta: taskMeta._meta,
                });
                if (immediateResponse) {
                  // Use immediate response as the content seen by the model
                  // while we continue polling in the background
                  result = { content: textContent(immediateResponse), isError: false };
                }

                // Register and poll
                const controller = taskTracker.register(task.taskId, taskClient);
                const outerSignal = config.signal;
                const onOuterAbort = () => controller.abort();
                outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

                const taskTimeoutMs = config.taskTimeoutMs ?? 120_000;

                try {
                  result = await Promise.race([
                    pollTask(taskClient, task, {
                      runId,
                      toolCallId: gatedCall.id,
                      events: this.events,
                      signal: controller.signal,
                    }),
                    new Promise<ToolResult>((resolve) =>
                      setTimeout(
                        () =>
                          resolve({
                            content: textContent(`Task timed out after ${taskTimeoutMs}ms`),
                            isError: true,
                          }),
                        taskTimeoutMs,
                      ),
                    ),
                  ]);
                } finally {
                  taskTracker.unregister(task.taskId);
                  outerSignal?.removeEventListener("abort", onOuterAbort);
                }
              }
              // If no taskClient available, fall through with the placeholder result
            }

            const ms = performance.now() - start;

            const finalResult = config.hooks?.afterToolCall
              ? await config.hooks.afterToolCall(gatedCall, result)
              : result;

            // Extract text output for persistence. The full structured result
            // is only attached when there's a resourceUri (inline UI), but the
            // text output is always needed for conversation history reconstruction.
            const outputText = extractTextForModel(finalResult.content);

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
              },
            });

            return { toolCall, result: finalResult, ms, resourceUri };
          }),
        );

        // Build result arrays from parallel results.
        // For tools with a UI resource, cap the content sent back to the LLM
        // to avoid token explosion from large binary payloads (e.g., base64 PNGs).
        // The full result is still available to the inline UI via tool.done event.
        const toolResultParts: LanguageModelV3ToolResultPart[] = [];

        for (const { toolCall, result, ms, resourceUri: uri } of toolResults) {
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
      // Cancel any active tasks on error
      await taskTracker.cancelAll();
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
      config.signal?.removeEventListener("abort", onAbort);
    }

    const stopReason = iteration >= maxIter ? "max_iterations" : "complete";
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
      inputTokens: cumulativeInputTokens,
      outputTokens: cumulativeOutputTokens,
      stopReason,
    };
  }
}
