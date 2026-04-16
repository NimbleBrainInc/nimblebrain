import { Check, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { useState } from "react";
import type { ToolCallDisplay } from "../hooks/useChat";
import type { VisualStatus } from "../hooks/useMinDisplayTime";
import { useMinDisplayTime } from "../hooks/useMinDisplayTime";
import { formatDuration, stripServerPrefix } from "../lib/format";

export type DisplayDetail = "quiet" | "balanced" | "verbose";

interface ToolCallIndicatorProps {
  toolCalls: ToolCallDisplay[];
  displayDetail: DisplayDetail;
}

function StatusIcon({ status }: { status: "running" | "done" | "error" }) {
  if (status === "running") {
    return <Loader2 className="w-3 h-3 text-processing animate-spin" aria-label="Running" />;
  }
  if (status === "done") {
    return <Check className="w-3 h-3 text-success" aria-label="Done" />;
  }
  return <X className="w-3 h-3 text-destructive" aria-label="Error" />;
}

function ToolLine({ toolCall, visual }: { toolCall: ToolCallDisplay; visual: VisualStatus }) {
  const [expanded, setExpanded] = useState(false);
  const hasResult = toolCall.result != null;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasResult && setExpanded((prev) => !prev)}
        className={`flex items-center gap-1.5 text-xs text-muted-foreground font-mono py-0.5 w-full text-left ${
          hasResult ? "cursor-pointer hover:text-foreground transition-colors" : "cursor-default"
        }`}
      >
        <span className="shrink-0 w-4 h-4 flex items-center justify-center">
          <StatusIcon status={visual.status} />
        </span>
        <span className="truncate flex-1">{stripServerPrefix(toolCall.name)}</span>
        {visual.ms != null && (
          <span className="shrink-0 tabular-nums">{formatDuration(visual.ms)}</span>
        )}
        {hasResult && (
          <span className="shrink-0">
            {expanded ? (
              <ChevronUp className="w-2.5 h-2.5" />
            ) : (
              <ChevronDown className="w-2.5 h-2.5" />
            )}
          </span>
        )}
      </button>
      {expanded && toolCall.result != null && (
        <div className="mt-1 ml-5 rounded-lg border border-border bg-muted/50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Result
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(
                  typeof toolCall.result === "string"
                    ? toolCall.result
                    : JSON.stringify(toolCall.result, null, 2),
                );
              }}
              className="text-[10px] text-primary hover:text-primary/80 transition-colors"
            >
              copy
            </button>
          </div>
          <pre className="px-3 py-2 text-[11px] leading-relaxed font-mono text-muted-foreground max-h-40 overflow-auto whitespace-pre-wrap break-words">
            {typeof toolCall.result === "string"
              ? toolCall.result
              : JSON.stringify(toolCall.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ToolCallIndicator({ toolCalls, displayDetail }: ToolCallIndicatorProps) {
  const [expanded, setExpanded] = useState(false);
  const visualStatuses = useMinDisplayTime(toolCalls);

  if (displayDetail === "quiet" || toolCalls.length === 0) {
    return null;
  }

  const totalMs = toolCalls.reduce((sum, tc) => sum + (tc.ms ?? 0), 0);
  const anyRunning = visualStatuses.some((v) => v.status === "running");

  if (displayDetail === "balanced") {
    return (
      <div className="my-1">
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground bg-transparent border-none cursor-pointer hover:text-foreground transition-colors px-0 py-0.5"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {anyRunning ? (
            <Loader2
              className="w-3 h-3 text-processing animate-spin shrink-0"
              aria-label="Running"
            />
          ) : (
            <Check className="w-3 h-3 text-success shrink-0" aria-label="Done" />
          )}
          <span className="font-mono">
            {toolCalls.length} tool{toolCalls.length !== 1 ? "s" : ""} used
            {!anyRunning && totalMs > 0 && (
              <span className="tabular-nums"> &middot; {formatDuration(totalMs)}</span>
            )}
          </span>
          <span className="text-[10px]">
            {expanded ? (
              <ChevronUp className="w-2.5 h-2.5" />
            ) : (
              <ChevronDown className="w-2.5 h-2.5" />
            )}
          </span>
        </button>
        {expanded && (
          <div className="pl-1 mt-0.5">
            {toolCalls.map((tc, i) => (
              <ToolLine key={tc.id} toolCall={tc} visual={visualStatuses[i]} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // verbose: always expanded
  return (
    <div className="my-1">
      {toolCalls.map((tc, i) => (
        <ToolLine key={tc.id} toolCall={tc} visual={visualStatuses[i]} />
      ))}
    </div>
  );
}
