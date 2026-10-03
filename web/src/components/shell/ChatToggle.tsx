// ---------------------------------------------------------------------------
// ChatToggle — the top bar's Chat button, the one control that opens and
// closes the chat panel by pointer (⌘J by keyboard).
//
// It reads only `ChatPanelContext`: the unread count is kept by `ChatChrome`,
// because counting replies means reading `ChatContext`, which re-renders on
// every streamed token and is off limits to shell chrome. Its element is the
// panel's `toggleButtonRef`, so focus left in the panel when it closes lands
// here.
// ---------------------------------------------------------------------------

import { MessageSquare } from "lucide-react";
import { useChatPanelContext } from "../../context/ChatPanelContext";
import { ariaKeyShortcuts, SHORTCUTS } from "../../lib/shortcuts";
import { Tooltip } from "../ui/tooltip";

export function ChatToggle() {
  const { panelState, openPanel, closePanel, unreadCount, toggleButtonRef } = useChatPanelContext();
  const open = panelState !== "closed";

  return (
    <Tooltip label={open ? "Close chat" : "Open chat"} shortcut={SHORTCUTS.chat}>
      <button
        ref={toggleButtonRef}
        type="button"
        onClick={() => (open ? closePanel() : openPanel())}
        aria-label={unreadCount > 0 ? `Chat, ${unreadCount} unread` : "Chat"}
        aria-pressed={open}
        aria-keyshortcuts={ariaKeyShortcuts(SHORTCUTS.chat)}
        data-testid="chat-chrome-open-button"
        className="relative flex h-8 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-foreground/5"
      >
        <MessageSquare aria-hidden="true" className="size-4" />
        Chat
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-3xs text-destructive-foreground"
          >
            {unreadCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
