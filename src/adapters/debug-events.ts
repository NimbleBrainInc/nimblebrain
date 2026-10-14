import type { EngineEvent, EventSink } from "../engine/types.ts";

/**
 * Verbose event sink that logs full details to stderr.
 * Activated via --debug flag.
 */
export class DebugEventSink implements EventSink {
  emit(event: EngineEvent): void {
    const ts = new Date().toISOString().slice(11, 23);

    // For run.start, print the system prompt as readable text instead of JSON
    if (event.type === "run.start") {
      const { systemPrompt, ...rest } = event.data;
      const meta = JSON.stringify(rest, null, 2);
      console.error(`[debug ${ts}] ${event.type}\n${meta}`);
      console.error(
        `\n${"=".repeat(60)}\n  SYSTEM PROMPT (${systemPrompt.length} chars)\n${"=".repeat(60)}\n${systemPrompt}\n${"=".repeat(60)}\n`,
      );
      const { messageCount, estimatedMessageTokens, messageRoles } = event.data;
      console.error(
        `  MESSAGES (${messageCount} messages, ~${estimatedMessageTokens} tokens est.)\n  Roles: ${messageRoles.join(" → ")}\n`,
      );
      return;
    }

    const data = JSON.stringify(event.data, null, 2);
    console.error(`[debug ${ts}] ${event.type}\n${data}`);
  }
}
