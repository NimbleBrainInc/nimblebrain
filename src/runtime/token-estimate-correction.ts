import type {
  ContextAssembledEvent,
  ConversationEvent,
  LlmResponseEvent,
  RunStartEvent,
} from "../conversation/types.ts";

const DISJOINT_SOURCES = ["system_prompt", "tool_descriptions", "history"] as const;
export const MAX_TOKEN_ESTIMATE_CORRECTION = 1.5;

/** The prompt estimate for one run, excluding the skills row already counted in the system. */
function estimatedPromptTokens(context: ContextAssembledEvent): number | null {
  const tokens = new Map<string, number>();
  for (const source of context.sources) {
    if (!DISJOINT_SOURCES.some((kind) => kind === source.kind)) continue;
    if (tokens.has(source.kind) || !Number.isFinite(source.tokens) || source.tokens < 0)
      return null;
    tokens.set(source.kind, source.tokens);
  }
  if (DISJOINT_SOURCES.some((kind) => !tokens.has(kind))) return null;
  const estimate = DISJOINT_SOURCES.reduce((sum, kind) => sum + (tokens.get(kind) ?? 0), 0);
  return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}

function latestRunStart(
  events: readonly ConversationEvent[],
): { event: RunStartEvent; index: number } | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "run.start") return { event, index };
  }
  return null;
}

function correctionFromPair(
  context: ContextAssembledEvent | null,
  response: LlmResponseEvent,
  model: string,
): number {
  const estimate = context ? estimatedPromptTokens(context) : null;
  const actual = response.usage.inputTokens;
  if (response.model !== model || estimate === null || !Number.isFinite(actual) || actual <= 0)
    return 1;
  return Math.min(MAX_TOKEN_ESTIMATE_CORRECTION, Math.max(1, actual / estimate));
}

/**
 * Bound the previous run's provider-measured input over its pre-flight estimate.
 * The first response matches the one `context.assembled` snapshot for that run;
 * later agentic-loop responses include a grown prompt and cannot calibrate it.
 * A missing or unusable measurement leaves the existing safety margin in charge.
 */
export function tokenEstimateCorrection(
  events: readonly ConversationEvent[],
  model: string,
): number {
  const start = latestRunStart(events);
  if (!start || start.event.model !== model) return 1;

  let context: ContextAssembledEvent | null = null;
  for (let index = start.index + 1; index < events.length; index++) {
    const event = events[index];
    if (!event) continue;
    if (event.type === "context.assembled" && event.runId === start.event.runId) {
      context ??= event;
    }
    if (event.type === "llm.response" && event.runId === start.event.runId) {
      return correctionFromPair(context, event, model);
    }
    if (
      (event.type === "run.done" || event.type === "run.error") &&
      event.runId === start.event.runId
    ) {
      break;
    }
  }
  return 1;
}
