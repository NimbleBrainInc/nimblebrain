import { Check, ChevronDown, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import type { ToolCallDisplay } from "../hooks/useChat";
import type { VisualStatus } from "../hooks/useMinDisplayTime";
import { useMinDisplayTime } from "../hooks/useMinDisplayTime";
import { formatDuration, stripServerPrefix } from "../lib/format";
import type { DisplayDetail } from "./ToolCallIndicator";

/** Summarize tool input as a one-line preview (e.g., "query: SELECT * FROM...") */
function summarizeInput(input: Record<string, unknown>): string | null {
  const keys = Object.keys(input);
  if (keys.length === 0) return null;
  // Pick the most interesting key (prefer content-like keys)
  const priority = [
    "query",
    "source",
    "content",
    "message",
    "text",
    "body",
    "code",
    "prompt",
    "name",
    "id",
  ];
  const key = priority.find((k) => k in input) ?? keys[0];
  const val = input[key];
  if (val == null) return null;
  const str = typeof val === "string" ? val : JSON.stringify(val);
  const preview = str.length > 48 ? `${str.slice(0, 48)}…` : str;
  // Collapse whitespace for readability
  return `${key}: ${preview.replace(/\s+/g, " ")}`;
}

function formatResult(result: unknown): string {
  if (typeof result === "string") {
    try {
      return JSON.stringify(JSON.parse(result), null, 2);
    } catch {
      return result;
    }
  }
  return JSON.stringify(result, null, 2);
}

function dotClass(status: "running" | "done" | "error"): string {
  if (status === "running") return "flash-dot flash-dot--running";
  if (status === "error") return "flash-dot flash-dot--error";
  return "flash-dot";
}

function cardClass(status: "running" | "done" | "error"): string {
  if (status === "running") return "flash-card flash-card--running";
  if (status === "error") return "flash-card flash-card--error";
  return "flash-card";
}

interface FlashCardProps {
  toolCall: ToolCallDisplay;
  visual: VisualStatus;
}

function FlashCard({ toolCall, visual }: FlashCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasResult = toolCall.result != null;

  const handleCopy = useCallback(() => {
    if (toolCall.result != null) {
      navigator.clipboard.writeText(formatResult(toolCall.result));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [toolCall.result]);

  // Build a one-line input preview (e.g., "query: SELECT * FROM...")
  const inputPreview = toolCall.input ? summarizeInput(toolCall.input) : null;

  return (
    <div className={cardClass(visual.status)}>
      {/* Summary row */}
      <button
        type="button"
        onClick={() => hasResult && setExpanded((prev) => !prev)}
        className={`flex items-center gap-2 w-full text-left px-3 py-2 ${
          hasResult ? "cursor-pointer hover:bg-muted/50 transition-colors" : "cursor-default"
        }`}
      >
        <div className={dotClass(visual.status)} />
        <div className="flex flex-col flex-1 min-w-0">
          <span className="text-[13px] text-muted-foreground truncate">
            {stripServerPrefix(toolCall.name)}
          </span>
          {inputPreview && (
            <span className="text-[11px] text-muted-foreground/50 truncate">{inputPreview}</span>
          )}
        </div>
        {visual.ms != null && visual.ms > 0 && (
          <span className="text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
            {formatDuration(visual.ms)}
          </span>
        )}
        {hasResult && (
          <ChevronDown
            className={`w-3.5 h-3.5 text-muted-foreground/60 shrink-0 transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        )}
      </button>

      {/* Expanded result */}
      {expanded && hasResult && (
        <div className="border-t border-border">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Result
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="text-[10px] text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3" /> copied
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" /> copy
                </>
              )}
            </button>
          </div>
          <div className="border-t border-border bg-muted/30 max-h-48 w-0 min-w-full overflow-auto">
            <pre className="px-3 py-2 text-[11px] leading-relaxed font-mono text-muted-foreground whitespace-pre">
              {formatResult(toolCall.result)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

interface FlashCardGroupProps {
  toolCalls: ToolCallDisplay[];
  displayDetail: DisplayDetail;
}

export function FlashCardGroup({ toolCalls, displayDetail }: FlashCardGroupProps) {
  const visualStatuses = useMinDisplayTime(toolCalls);

  if (displayDetail === "quiet" || toolCalls.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {toolCalls.map((tc, i) => (
        <FlashCard key={tc.id} toolCall={tc} visual={visualStatuses[i]} />
      ))}
    </div>
  );
}
