/**
 * Write conversation fixtures as the event log the runtime writes.
 *
 * Tests describe a conversation as a list of turns — the shape that reads
 * naturally in a test — and this turns it into the JSONL event lines the
 * event-sourced store would have written for those turns: a `user.message` per
 * user turn, and per assistant turn a run (`run.start`, one `llm.response`
 * carrying the text and tool calls, a `tool.start`/`tool.done` pair per call,
 * `run.done`).
 */

/** A tool call as a fixture spells it. */
export interface FixtureToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  ok?: boolean;
  ms?: number;
  resourceUri?: string;
  resourceLinks?: Array<{ uri: string; name?: string; mimeType?: string; description?: string }>;
}

/** Token usage as a fixture spells it. */
export interface FixtureUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** One turn of a conversation fixture. */
export interface FixtureTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  userId?: string;
  metadata?: {
    usage?: FixtureUsage;
    model?: string;
    llmMs?: number;
    toolCalls?: FixtureToolCall[];
  };
}

/** The events for one fixture turn. `runId` names an assistant turn's run. */
export function turnEvents(turn: FixtureTurn, runId: string): Record<string, unknown>[] {
  const ts = turn.timestamp;
  if (turn.role === "user") {
    return [
      {
        ts,
        type: "user.message",
        content: turn.content ? [{ type: "text", text: turn.content }] : [],
        ...(turn.userId ? { userId: turn.userId } : {}),
      },
    ];
  }
  const model = turn.metadata?.model ?? "unknown";
  const toolCalls = turn.metadata?.toolCalls ?? [];
  const content: Record<string, unknown>[] = [];
  if (turn.content) content.push({ type: "text", text: turn.content });
  for (const tc of toolCalls) {
    content.push({
      type: "tool-call",
      toolCallId: tc.id,
      toolName: tc.name,
      input: JSON.stringify(tc.input ?? {}),
    });
  }
  const llmMs = turn.metadata?.llmMs ?? 0;
  return [
    { ts, type: "run.start", runId, model },
    {
      ts,
      type: "llm.response",
      runId,
      model,
      content,
      usage: turn.metadata?.usage ?? { inputTokens: 0, outputTokens: 0 },
      llmMs,
    },
    ...toolCalls.flatMap((tc) => [
      { ts, type: "tool.start", runId, name: tc.name, id: tc.id },
      {
        ts,
        type: "tool.done",
        runId,
        name: tc.name,
        id: tc.id,
        ok: tc.ok ?? true,
        ms: tc.ms ?? 0,
        output: tc.output ?? "",
        ...(tc.resourceUri ? { resourceUri: tc.resourceUri } : {}),
        ...(tc.resourceLinks ? { resourceLinks: tc.resourceLinks } : {}),
      },
    ]),
    { ts, type: "run.done", runId, stopReason: "complete", totalMs: llmMs },
  ];
}

/** Every turn's events, serialized one per line (no header). */
export function conversationEventLines(turns: FixtureTurn[]): string[] {
  let run = 0;
  return turns
    .flatMap((t) => turnEvents(t, t.role === "assistant" ? `run-${run++}` : ""))
    .map((e) => JSON.stringify(e));
}
