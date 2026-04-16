import type { LanguageModelV3 } from "@ai-sdk/provider";

/**
 * Generate a short conversation title using the provided model.
 * Non-blocking — call fire-and-forget after first turn.
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
            "Generate a 3-6 word title for this conversation. Return only the title, nothing else.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `User: ${userMessage.slice(0, 200)}\nAssistant: ${assistantResponse.slice(0, 200)}`,
            },
          ],
        },
      ],
      maxOutputTokens: 30,
    });
    const textBlock = result.content.find((b) => b.type === "text");
    if (textBlock?.type === "text") {
      return textBlock.text.trim();
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
