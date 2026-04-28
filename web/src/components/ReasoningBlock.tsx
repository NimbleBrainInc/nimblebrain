/**
 * ReasoningBlock — collapsed-by-default view of the model's extended-thinking
 * content. Renders above the assistant's visible text, signaling that
 * the model deliberated before responding without crowding the message body.
 *
 * Interaction:
 *   - Collapsed (default): single-line "Thoughts" affordance with a chevron.
 *   - Expanded: the full reasoning text in a subdued container.
 *
 * Live streaming: while reasoning deltas are arriving, the block stays
 * collapsed but shows a subtle "thinking…" indicator so the user knows
 * the model is actively reasoning.
 */

import { Brain, ChevronRight } from "lucide-react";
import { memo, useState } from "react";

interface ReasoningBlockProps {
  text: string;
  /** True when the run is still streaming and reasoning may grow. */
  streaming?: boolean;
}

function ReasoningBlockImpl({ text, streaming }: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(false);

  if (!text && !streaming) return null;

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Brain className="w-3 h-3" />
        <span>{streaming && !text ? "Thinking…" : "Thoughts"}</span>
      </button>
      {expanded && text && (
        <div className="mt-2 ml-4 px-3 py-2 rounded-md bg-muted/30 border border-border/60 text-sm text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

export const ReasoningBlock = memo(ReasoningBlockImpl);
