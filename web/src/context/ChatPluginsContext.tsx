import { createContext, useContext } from "react";
import type { Plugin } from "../_generated/platform-schemas/plugins";

/**
 * The plugins of the workspace the chat runs in, for naming the plugin behind
 * each tool call and loaded skill in the timeline.
 *
 * Kept apart from the provider, as `WorkspaceAppIconsContext` is, so a
 * component reads it without pulling in the provider's fetch and SSE chain. The
 * default is an empty listing: a timeline rendered outside the provider, or
 * before the first fetch lands, labels nothing and otherwise renders as usual.
 */
export const ChatPluginsContext = createContext<readonly Plugin[]>([]);

export function useChatPlugins(): readonly Plugin[] {
  return useContext(ChatPluginsContext);
}
