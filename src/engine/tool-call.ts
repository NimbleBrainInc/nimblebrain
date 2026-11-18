/**
 * One tool call's checks and record, shared by every path that dispatches a
 * model's tool call through a `ToolRouter`: the engine's own loop, and the tool
 * projection an external agent runtime calls back through
 * (`src/execution/tool-projection.ts`). The same input reaches the same tool,
 * and leaves the same `tool.done` record, whichever loop asked for it.
 */

import { log } from "../observability/log.ts";
import { coerceInputForSchema } from "../tools/coerce-input.ts";
import { validateToolInput } from "../tools/validate-input.ts";
import { estimateContentSize, type ResourceLinkInfo, textContent } from "./content-helpers.ts";
import type { ToolDonePayload } from "./schemas/events.ts";
import type { SupervisorVerdict } from "./supervisor.ts";
import type { ToolResult, ToolSchema } from "./types.ts";
import { formatUnknownArgumentsError, unknownArgumentNames } from "./unknown-tool-args.ts";

/**
 * `structuredContent.reason` of a call rejected for its arguments before
 * anything ran: an unknown argument name or a value the schema refuses. The
 * same code a connector's error envelope carries for its own rejection (see
 * {@link errorReasonField}), so a consumer reads one value either way.
 */
export const INVALID_TOOL_INPUT = "bad_input";

/**
 * Coerce a model tool call's input against its declared schema, then validate it.
 * Coerce first: models occasionally emit nested object/array values as
 * JSON-encoded strings (`{ manifest: "{...}" }`); the coerce pass uses the
 * schema as a parsing oracle to recover those one-level misencodings before
 * validation. An argument name the schema does not declare is rejected with
 * the declared arguments listed (see unknown-tool-args.ts); the check runs
 * against the tool's own schema, not the LLM-flattened one. Returns the
 * (possibly coerced) input plus an isError result when validation fails. With
 * no schema the input passes through unchanged.
 */
export function coerceAndValidateToolInput(
  input: Record<string, unknown>,
  toolSchema: ToolSchema | undefined,
): { input: Record<string, unknown>; errorResult?: ToolResult } {
  if (!toolSchema?.inputSchema) return { input };
  const schema = toolSchema.inputSchema as Record<string, unknown>;
  const coerced = coerceInputForSchema(input, schema);
  const unknown = unknownArgumentNames(coerced, schema);
  if (unknown.length > 0) {
    log.info("[engine] invalid_input.unknown_keys", { tool: toolSchema.name, keys: unknown });
    return {
      input: coerced,
      errorResult: {
        content: textContent(formatUnknownArgumentsError(toolSchema.name, unknown, schema)),
        isError: true,
        structuredContent: { reason: INVALID_TOOL_INPUT },
      },
    };
  }
  // A schema that does not compile passes: the connector checks its own input.
  const validation = validateToolInput(coerced, schema, { uncompilable: "pass" });
  if (!validation.valid) {
    return {
      input: coerced,
      errorResult: {
        content: textContent(`Invalid tool input: ${validation.error}`),
        isError: true,
        structuredContent: { reason: INVALID_TOOL_INPUT },
      },
    };
  }
  return { input: coerced };
}

/**
 * The failure reason a tool error result states, as `ToolCallRecord.errorReason`.
 *
 * Two shapes carry one: `structuredContent.reason` (the orchestrator's routing
 * classes, the engine's own holds and rejections) and the error envelope a
 * connector on the platform error contract returns, `structuredContent.error`
 * with a string `code` (`bad_input`, `upstream_unavailable`, …). `reason` wins
 * when both are present. Empty when the result states neither.
 */
export function errorReasonField(result: ToolResult): { errorReason?: string } {
  const structured = result.structuredContent;
  if (typeof structured?.reason === "string") return { errorReason: structured.reason };
  const envelope = structured?.error;
  if (envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)) {
    const code = (envelope as { code?: unknown }).code;
    if (typeof code === "string") return { errorReason: code };
  }
  return {};
}

/**
 * Reject an oversized tool result before it propagates through event emission,
 * hooks, or history accumulation — replacing it with an isError summary.
 * `maxToolResultSize` of 0 disables the guard; absent defaults to 1M chars.
 */
export function enforceMaxToolResultSize(
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
export function buildToolDoneData(params: {
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
  held?: true;
}): ToolDonePayload {
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
    held,
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
    ...(held ? { held } : {}),
    ...(verdict.type === "synth"
      ? {
          supervisorTripped: true,
          trippedTool: verdict.trippedTool,
          consecutiveRepeats: verdict.consecutiveRepeats,
        }
      : {}),
  };
}
