import { Check, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { useState } from "react";
import type { ToolCallDisplay } from "../hooks/useChat";

function parseToolName(raw: string): { server: string; tool: string } {
  const idx = raw.indexOf("__");
  if (idx === -1) return { server: "", tool: raw };
  return { server: raw.slice(0, idx), tool: raw.slice(idx + 2) };
}

interface ToolCallProps {
  toolCall: ToolCallDisplay;
}

export function ToolCall({ toolCall }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const { server, tool } = parseToolName(toolCall.name);

  return (
    <div
      className={
        toolCall.status === "running"
          ? "border border-processing/10 rounded-md bg-processing/5 text-xs overflow-hidden"
          : toolCall.status === "done" && toolCall.ok
            ? "border border-success/10 rounded-md bg-success/5 text-xs overflow-hidden"
            : "border border-destructive/10 rounded-md bg-destructive/5 text-xs overflow-hidden"
      }
    >
      <button
        className="flex items-center gap-1.5 w-full px-2 py-1.5 bg-transparent border-none cursor-pointer text-xs text-foreground text-left hover:bg-accent transition-colors"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="shrink-0 w-4 h-4 flex items-center justify-center">
          {toolCall.status === "running" && (
            <Loader2 className="w-3 h-3 text-processing animate-spin" />
          )}
          {toolCall.status === "done" && toolCall.ok && (
            <Check className="w-3.5 h-3.5 text-success" />
          )}
          {(toolCall.status === "error" || (toolCall.status === "done" && !toolCall.ok)) && (
            <X className="w-3.5 h-3.5 text-destructive" />
          )}
        </span>
        <span className="flex items-center gap-0.5 flex-1 min-w-0 truncate font-mono">
          {server && (
            <span className="text-muted-foreground">
              {server}
              <span className="mx-px">/</span>
            </span>
          )}
          <span className="font-medium">{tool}</span>
        </span>
        {toolCall.ms != null && (
          <span className="text-muted-foreground shrink-0 tabular-nums">{toolCall.ms}ms</span>
        )}
        <span className="text-muted-foreground shrink-0 text-[10px]">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
      </button>
      {expanded && (
        <div className="px-2 py-1.5 border-t border-border bg-accent/50 font-mono text-[11px] text-muted-foreground">
          <div className="py-0.5">
            <span className="font-semibold text-foreground/70">ID:</span> {toolCall.id}
          </div>
          {toolCall.ms != null && (
            <div className="py-0.5">
              <span className="font-semibold text-foreground/70">Duration:</span> {toolCall.ms}ms
            </div>
          )}
          <div className="py-0.5">
            <span className="font-semibold text-foreground/70">Status:</span>{" "}
            {toolCall.ok === true ? "Success" : toolCall.ok === false ? "Error" : "Running"}
          </div>
        </div>
      )}
    </div>
  );
}
