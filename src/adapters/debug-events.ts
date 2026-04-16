import type { EngineEvent, EventSink } from "../engine/types.ts";

/**
 * Verbose event sink that logs full details to stderr.
 * Activated via --debug flag.
 */
export class DebugEventSink implements EventSink {
  emit(event: EngineEvent): void {
    const ts = new Date().toISOString().slice(11, 23);

    // For run.start, print the system prompt as readable text instead of JSON
    if (event.type === "run.start" && typeof event.data.systemPrompt === "string") {
      const { systemPrompt, ...rest } = event.data;
      const meta = JSON.stringify(rest, null, 2);
      console.error(`[debug ${ts}] ${event.type}\n${meta}`);
      console.error(
        `\n${"=".repeat(60)}\n  SYSTEM PROMPT (${(systemPrompt as string).length} chars)\n${"=".repeat(60)}\n${systemPrompt}\n${"=".repeat(60)}\n`,
      );
      if (typeof event.data.messageCount === "number") {
        const count = event.data.messageCount as number;
        const tokens = event.data.estimatedMessageTokens as number;
        const roles = (event.data.messageRoles as string[])?.join(" → ") ?? "";
        console.error(
          `  MESSAGES (${count} messages, ~${tokens} tokens est.)\n  Roles: ${roles}\n`,
        );
      }
      return;
    }

    const data = JSON.stringify(event.data, null, 2);
    console.error(`[debug ${ts}] ${event.type}\n${data}`);
  }
}
