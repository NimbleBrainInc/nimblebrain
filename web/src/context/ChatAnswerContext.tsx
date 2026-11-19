import { createContext, useContext } from "react";
import type { PluginRequestAnswer } from "../_generated/platform-schemas/plugins";

/**
 * What a card in the transcript needs to answer a request the agent made of
 * the person (a plugin request): the chat's workspace and a way to send the
 * answer as the person's next message. Null outside a chat panel, where a card
 * renders read-only.
 */
export interface ChatAnswer {
  /** The conversation the card is in, which a sign-in it starts returns to. */
  conversationId: string | undefined;
  workspaceId: string | undefined;
  workspaceName: string | undefined;
  /** False while a turn is running: an answer waits for the agent to stop. */
  canAnswer: boolean;
  /** Send `text` as the person's next message, marked as the answer it carries. */
  send: (text: string, pluginRequestAnswer?: PluginRequestAnswer) => Promise<void>;
}

export const ChatAnswerContext = createContext<ChatAnswer | null>(null);

export function useChatAnswer(): ChatAnswer | null {
  return useContext(ChatAnswerContext);
}
