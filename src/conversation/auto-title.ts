import type { LanguageModelV3 } from "@ai-sdk/provider";

/**
 * Generate a short conversation title using the provided model.
 * Non-blocking — call fire-and-forget after first turn.
 *
 * The prompt uses real role turns (user → assistant → user-instruction) rather
 * than stuffing the whole transcript into one user string. The transcript-in-a-
 * string shape made the fast model pattern-match "continue the assistant" and
 * echo the response back as the title — worst on creative/long answers (#253).
 * A trailing user-role instruction is unambiguously a command, not text to
 * continue.
 */
export async function generateTitle(
  model: LanguageModelV3,
  userMessage: string,
  assistantResponse: string,
): Promise<string> {
  try {
    const result = await model.doGenerate({
      prompt: [
        {
          role: "system",
          content:
            "You generate short, descriptive titles for conversations. Reply with the title only.",
        },
        { role: "user", content: [{ type: "text", text: userMessage.slice(0, 500) }] },
        { role: "assistant", content: [{ type: "text", text: assistantResponse.slice(0, 500) }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Reply with a 3-6 word title summarizing this conversation. Output only the title — no quotes, no markdown, no preamble.",
            },
          ],
        },
      ],
      maxOutputTokens: 30,
    });
    const textBlock = result.content.find((b) => b.type === "text");
    if (textBlock?.type === "text") {
      return textBlock.text.trim() || fallbackTitle(userMessage);
    }
    return fallbackTitle(userMessage);
  } catch {
    return fallbackTitle(userMessage);
  }
}

/** Fallback: first ~60 chars of user message, trimmed at word boundary. */
export function fallbackTitle(message: string): string {
  if (message.length <= 60) return message;
  const truncated = message.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
}
