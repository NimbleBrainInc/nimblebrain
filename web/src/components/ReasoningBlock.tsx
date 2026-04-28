/**
 * ReasoningBlock — view of the model's extended-thinking content.
 *
 * Display rules:
 *   - While streaming: auto-expanded so the user can watch the model think.
 *     The header shows a pulsing brain + "Thinking… ~Nk tokens" so progress
 *     is visible at a glance even with the body collapsed.
 *   - After streaming: auto-collapses to "Thoughts · ~Nk tokens" so the
 *     reasoning doesn't crowd the message body. Click to expand.
 *   - User override: a manual click during streaming sticks for the rest
 *     of this block's lifetime (no fighting the user's intent).
 *
 * The block lifetime is one assistant turn — every new turn instantiates
 * a fresh component, so the override doesn't leak across messages.
 */

import { Brain, ChevronRight } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

interface ReasoningBlockProps {
  text: string;
  /** True when the run is still streaming and reasoning may grow. */
  streaming?: boolean;
}

/**
 * Approximate token count from character length using the standard
 * 4 chars/token heuristic. Real `reasoningTokens` comes from `llm.done`
 * after streaming, but for live progress we render the approximation —
 * it's accurate enough for "is the model still working?" judgment.
 */
function approximateTokenLabel(charCount: number): string {
  if (charCount === 0) return "";
  const tokens = Math.round(charCount / 4);
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

function ReasoningBlockImpl({ text, streaming }: ReasoningBlockProps) {
  // Default: expanded while streaming, collapsed when done.
  const [expanded, setExpanded] = useState(!!streaming);
  // Once the user manually toggles, stop auto-following the streaming flag.
  // Ref because we don't want a re-render when the override flips.
  const userOverrodeRef = useRef(false);

  useEffect(() => {
    if (!userOverrodeRef.current) {
      setExpanded(!!streaming);
    }
  }, [streaming]);

  const handleToggle = () => {
    userOverrodeRef.current = true;
    setExpanded((v) => !v);
  };

  if (!text && !streaming) return null;

  const tokenLabel = approximateTokenLabel(text.length);
  const headerLabel = streaming
    ? tokenLabel
      ? `Thinking… ${tokenLabel}`
      : "Thinking…"
    : tokenLabel
      ? `Thoughts · ${tokenLabel}`
      : "Thoughts";

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={handleToggle}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Brain className={`w-3 h-3 ${streaming ? "animate-pulse" : ""}`} />
        <span>{headerLabel}</span>
      </button>
      {expanded && text && (
        <div className="mt-2 ml-4 px-3 py-2 rounded-md bg-muted/30 border border-border/60 text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

export const ReasoningBlock = memo(ReasoningBlockImpl);
