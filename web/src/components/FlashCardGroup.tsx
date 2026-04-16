import { Check, ChevronDown, Copy } from "lucide-react";
import { type MouseEvent, useCallback, useState } from "react";
import type { ToolCallDisplay } from "../hooks/useChat";
import type { VisualStatus } from "../hooks/useMinDisplayTime";
import { useMinDisplayTime } from "../hooks/useMinDisplayTime";
import { formatDuration, stripServerPrefix } from "../lib/format";
import { partitionToolCalls } from "../lib/tool-grouping";
import type { DisplayDetail } from "./ToolCallIndicator";

/** Summarize tool input as a one-line preview (e.g., "query: SELECT * FROM...") */
function summarizeInput(input: Record<string, unknown>): string | null {
  const keys = Object.keys(input);
  if (keys.length === 0) return null;
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

// ─── Individual FlashCard ─────────────────────────────────────────

interface FlashCardProps {
  toolCall: ToolCallDisplay;
  visual: VisualStatus;
}

function FlashCard({ toolCall, visual }: FlashCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasResult = toolCall.result != null;

  const handleCopy = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (toolCall.result != null) {
        navigator.clipboard.writeText(formatResult(toolCall.result));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [toolCall.result],
  );

  const inputPreview = toolCall.input ? summarizeInput(toolCall.input) : null;

  return (
    <div className={cardClass(visual.status)}>
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

// ─── Grouped accordion row (inside expanded group) ────────────────

interface GroupedRowProps {
  toolCall: ToolCallDisplay;
  visual: VisualStatus;
  showName: boolean;
}

function GroupedRow({ toolCall, visual, showName }: GroupedRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasResult = toolCall.result != null;
  const inputPreview = toolCall.input ? summarizeInput(toolCall.input) : null;
  const label = inputPreview ?? toolCall.id;
  const name = stripServerPrefix(toolCall.name);

  const handleCopy = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (toolCall.result != null) {
        navigator.clipboard.writeText(formatResult(toolCall.result));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [toolCall.result],
  );

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        onClick={() => hasResult && setExpanded((prev) => !prev)}
        className={`flex items-center gap-2 w-full text-left px-3 py-1.5 ${
          hasResult ? "cursor-pointer hover:bg-muted/40 transition-colors" : "cursor-default"
        }`}
      >
        <div className={dotClass(visual.status)} style={{ width: 4, height: 4 }} />
        {showName && (
          <span className="text-[11px] text-muted-foreground/80 font-mono shrink-0">{name}</span>
        )}
        <span className="text-[11px] text-muted-foreground/60 truncate flex-1 font-mono">
          {label}
        </span>
        {visual.ms != null && visual.ms > 0 && (
          <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
            {formatDuration(visual.ms)}
          </span>
        )}
        {hasResult && (
          <ChevronDown
            className={`w-3 h-3 text-muted-foreground/40 shrink-0 transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        )}
      </button>

      {expanded && hasResult && (
        <div className="bg-muted/20 border-t border-border/60">
          <div className="flex items-center justify-between px-3 py-1">
            <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wide">
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
          <div className="max-h-40 w-0 min-w-full overflow-auto border-t border-border/60">
            <pre className="px-3 py-2 text-[11px] leading-relaxed font-mono text-muted-foreground whitespace-pre">
              {formatResult(toolCall.result)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Grouped FlashCard (accordion) ────────────────────────────────

interface GroupedFlashCardProps {
  toolCalls: ToolCallDisplay[];
  visuals: VisualStatus[];
  groupName: string; // tool name if homogeneous, or "__mixed__"
  uniqueNames: string[];
}

function GroupedFlashCard({
  toolCalls,
  visuals,
  groupName,
  uniqueNames,
}: GroupedFlashCardProps) {
  const [expanded, setExpanded] = useState(false);

  const anyRunning = visuals.some((v) => v.status === "running");
  const errorCount = toolCalls.filter((tc) => tc.status === "error").length;
  const totalMs = toolCalls.reduce((sum, tc) => sum + (tc.ms ?? 0), 0);
  const count = toolCalls.length;

  const aggregateStatus: "running" | "done" | "error" = anyRunning
    ? "running"
    : errorCount > 0
      ? "error"
      : "done";

  const isMixed = groupName === "__mixed__";
  const label = isMixed
    ? `${count} tool calls`
    : `${count} ${groupName} call${count !== 1 ? "s" : ""}`;

  return (
    <div className={cardClass(aggregateStatus)}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-2 w-full text-left px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
      >
        <div className={dotClass(aggregateStatus)} />
        <div className="flex flex-col flex-1 min-w-0">
          <span className="text-[13px] text-muted-foreground truncate">
            {label}
            {errorCount > 0 && (
              <span className="text-destructive ml-1.5 text-[11px]">
                ({errorCount} failed)
              </span>
            )}
          </span>
          {isMixed && (
            <span className="text-[11px] text-muted-foreground/50 truncate font-mono">
              {uniqueNames.join(", ")}
            </span>
          )}
        </div>
        {!anyRunning && totalMs > 0 && (
          <span className="text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
            {formatDuration(totalMs)}
          </span>
        )}
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted-foreground/60 shrink-0 transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="border-t border-border max-h-64 overflow-y-auto">
          {toolCalls.map((tc, i) => (
            <GroupedRow
              key={tc.id}
              toolCall={tc}
              visual={visuals[i]}
              showName={isMixed}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────

interface FlashCardGroupProps {
  toolCalls: ToolCallDisplay[];
  displayDetail: DisplayDetail;
}

export function FlashCardGroup({ toolCalls, displayDetail }: FlashCardGroupProps) {
  const visualStatuses = useMinDisplayTime(toolCalls);

  if (displayDetail === "quiet" || toolCalls.length === 0) return null;

  const units = partitionToolCalls(toolCalls);

  return (
    <div className="flex flex-col gap-2 w-full min-w-0">
      {units.map((unit, idx) => {
        if (unit.kind === "single") {
          const tc = unit.calls[0];
          const visual = visualStatuses[unit.indexes[0]];
          return <FlashCard key={tc.id} toolCall={tc} visual={visual} />;
        }
        const visuals = unit.indexes.map((i) => visualStatuses[i]);
        return (
          <GroupedFlashCard
            // biome-ignore lint/suspicious/noArrayIndexKey: units are positionally stable within a message block
            key={`group-${idx}-${unit.calls[0].id}`}
            toolCalls={unit.calls}
            visuals={visuals}
            groupName={unit.groupName!}
            uniqueNames={unit.uniqueNames ?? []}
          />
        );
      })}
    </div>
  );
}
