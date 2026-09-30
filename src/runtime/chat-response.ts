import type { ChatResponse } from "../api/schemas/responses.ts";
import { estimateCost } from "../usage/cost.ts";
import type { ChatResult } from "./types.ts";

/**
 * A finished turn as every client sees it: the body of `POST …/chat`, and the
 * `done` event of both chat streams. One builder, so the three cannot disagree.
 *
 * Cost is derived here, at the boundary, and never stored. There is no
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
    usage: { ...result.usage, costUsd: estimateCost(result.usage.model, result.usage) },
  };
}
