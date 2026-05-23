// ---------------------------------------------------------------------------
// Composer — Stage 2 / T013
//
// Thin wrapper around the existing MessageInput that mounts the new
// ComposerFooter below the input. Created as a new file (rather than
// modifying MessageInput in place) so the legacy ChatPanel + ChatDock
// callers that don't want the footer can keep using `MessageInput`
// directly; ChatPanel migrates to this wrapper.
//
// Why a wrapper and not inline-in-ChatPanel: the footer's
// "viewing line" + "TOOLS FROM" line are a self-contained breadcrumb
// surface with their own context dependencies (WorkspaceContext,
// ToolWorkspacesContext, react-router). Bundling them with the
// input here keeps the chrome predicable — a future "show the
// composer somewhere else" caller gets the footer automatically.
// ---------------------------------------------------------------------------

import type { StreamingState } from "../../hooks/useChat";
import { MessageInput } from "../MessageInput";
import { ComposerFooter } from "./ComposerFooter";

export interface ComposerProps {
  onSend: (text: string, files?: File[]) => void;
  disabled: boolean;
  onNewConversation?: () => void;
  streamingState?: StreamingState;
  /**
   * Hide the footer (e.g. for embedded / popover compositions where
   * vertical space is at a premium). Default: show.
   */
  hideFooter?: boolean;
}

export function Composer({
  onSend,
  disabled,
  onNewConversation,
  streamingState,
  hideFooter = false,
}: ComposerProps) {
  return (
    <div className="flex flex-col" data-testid="composer">
      <MessageInput
        onSend={onSend}
        disabled={disabled}
        onNewConversation={onNewConversation}
        streamingState={streamingState}
      />
      {!hideFooter && <ComposerFooter />}
    </div>
  );
}
