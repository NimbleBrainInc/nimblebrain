import { useState } from "react";
import { ChevronIcon } from "../icons.tsx";
import type { AutomationRun } from "../types.ts";
import { formatDuration, formatTokens, relativeTime, statusDotClass } from "../utils.ts";

export function RunRow({ run, showName }: { run: AutomationRun; showName?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const dotClass = statusDotClass(run.status, true);
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: complex row layout cannot be a simple button */}
      <div
        className="run-row"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <ChevronIcon open={expanded} />
        <span className={`dot ${dotClass}`} />
        <span className="run-name">{showName ? run.automationId || "unknown" : run.status}</span>
        <span className="run-time">{relativeTime(run.startedAt)}</span>
        <span className="run-duration">{formatDuration(run.startedAt, run.completedAt)}</span>
      </div>
      {expanded && (
        <div className="run-expanded">
          {run.resultPreview && (
            <div>
              <div
                style={{
                  fontWeight: 500,
                  marginBottom: 4,
                  color: "var(--color-text-primary, #171717)",
                }}
              >
                Result
              </div>
              <pre>{run.resultPreview}</pre>
            </div>
          )}
          {run.error && (
            <div style={{ marginTop: 8 }}>
              <div
                style={{
                  fontWeight: 500,
                  marginBottom: 4,
                  color: "var(--nb-color-danger, #dc2626)",
                }}
              >
                Error
              </div>
              <pre
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--nb-color-danger, #dc2626) 25%, transparent)",
                  color: "var(--nb-color-danger, #dc2626)",
                }}
              >
                {run.error}
              </pre>
            </div>
          )}
          <div className="run-expanded-meta">
            <span>
              Tokens: {formatTokens(run.inputTokens)} in / {formatTokens(run.outputTokens)} out
            </span>
            <span>Iterations: {run.iterations ?? "-"}</span>
            <span>Tool calls: {run.toolCalls ?? "-"}</span>
            {run.stopReason && <span>Stop: {run.stopReason}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
