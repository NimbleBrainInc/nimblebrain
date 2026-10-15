import type { ChatResponse } from "../api/schemas/responses.ts";
import type { ChatResult } from "./types.ts";

/**
 * A finished turn as every client sees it: the `done` event of the
 * conversation stream.
 *
 * Cost is the run's per-call sum (`ChatResult.costUsd`), never stored. There is no
 * result-level workspace: per-tool-call attribution is on each `tool.done`
 * event's `workspaceId`.
 */
export function chatResponseBody(result: ChatResult): ChatResponse {
  return {
    response: result.response,
    conversationId: result.conversationId,
    skillName: result.skillName,
    toolCalls: result.toolCalls,
    stopReason: result.stopReason,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    usage: { ...result.usage, costUsd: result.costUsd },
  };
}
