// ---------------------------------------------------------------------------
// Composer — thin wrapper around MessageInput.
//
// Keeps the chat input as a named seam (own container + test id) so
// ChatPanel and any future caller mount it uniformly, and a later
// composer-level affordance (toolbar, breadcrumb) has one place to land.
// ---------------------------------------------------------------------------

import type { StreamingState } from "../../hooks/useChat";
import { MessageInput } from "../MessageInput";

export interface ComposerProps {
  onSend: (text: string, files?: File[]) => void;
  disabled: boolean;
  onNewConversation?: () => void;
  streamingState?: StreamingState;
  /** Stop the in-flight turn — wired to the Stop button in MessageInput. */
  onStop?: () => void;
}

export function Composer({
  onSend,
  disabled,
  onNewConversation,
  streamingState,
  onStop,
}: ComposerProps) {
  return (
    <div className="flex flex-col" data-testid="composer">
      <MessageInput
        onSend={onSend}
        disabled={disabled}
        onNewConversation={onNewConversation}
        streamingState={streamingState}
        onStop={onStop}
      />
    </div>
  );
}
