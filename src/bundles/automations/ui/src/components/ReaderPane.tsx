import { useCallTool } from "@nimblebrain/synapse/react";
import { useEffect, useState } from "react";
import { BackArrowIcon } from "../icons.tsx";
import { renderMarkdown } from "../markdown.ts";
import type { AutomationRun, AutomationRunResult, AutomationSummary } from "../types.ts";
import { formatDuration, formatTokens, relativeTime, statusDotClass } from "../utils.ts";

const STATUS_LABEL: Record<string, string> = {
  success: "Run succeeded",
  failure: "Run failed",
  timeout: "Run timed out",
  running: "Running…",
  cancelled: "Run cancelled",
  skipped: "Run skipped",
};

export function ReaderPane({
  run,
  automation,
  onRerun,
  onOpenConfig,
  onBack,
}: {
  run: AutomationRun | null;
  /** The parent automation for this run, if it still exists. */
  automation: AutomationSummary | undefined;
  /** Trigger a fresh run of the parent automation. */
  onRerun: (name: string) => void;
  /** Open the automation's config view. */
  onOpenConfig: (name: string) => void;
  /** Return to the rail (used at narrow widths where rail and reader stack). */
  onBack?: () => void;
}) {
  const runResultTool = useCallTool<AutomationRunResult>("run_result");
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<AutomationRunResult | null>(null);

  const automationName = automation?.name || run?.automationId || "unknown";

  // Fetch the full run result (deliverable + activity log + output files) for a
  // terminal run. The run-list summary only carries a truncated preview; the
  // sidecar holds the whole thing. Best-effort: a missing sidecar (legacy run,
  // deleted automation) just leaves us with the preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runResultTool.call is stable; re-fetch only when the selected run or its automation changes
  useEffect(() => {
    setResult(null);
    if (!run || run.status === "running" || run.status === "skipped") return;
    if (!automation) return; // orphaned run — no automation to resolve by name
    const runId = run.id;
    let cancelled = false;
    runResultTool
      .call({ name: automationName, runId })
      .then((res) => {
        if (!cancelled) setResult((res.data as AutomationRunResult) ?? null);
      })
      .catch(() => {
        // No sidecar (legacy/partial run) — fall back to the summary preview.
      });
    return () => {
      cancelled = true;
    };
  }, [run, automation, automationName]);

  if (!run) {
    return (
      <div className="reader">
        <div className="reader-empty">
          <div className="reader-empty-title">No run selected</div>
          <div className="reader-empty-desc">
            Pick a run from the list to read its output, or create an automation to get one going.
          </div>
        </div>
      </div>
    );
  }

  const dotClass = statusDotClass(run.status, true);
  const statusLabel = STATUS_LABEL[run.status] || run.status;
  const orphan = !automation;
  // Prefer the full deliverable from the result sidecar; fall back to the
  // truncated summary preview while it loads or when no sidecar exists.
  const output = result?.output ?? run.resultPreview ?? "";
  const activityLog = result?.activityLog ?? [];
  const outputFiles = result?.outputFiles ?? [];

  async function handleCopy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable in some contexts; silent
    }
  }

  return (
    <div className="reader">
      <div className="reader-head">
        {onBack && (
          <button type="button" className="reader-back" onClick={onBack} aria-label="Back to list">
            <BackArrowIcon />
          </button>
        )}
        <div className="reader-head-meta">
          <div className="reader-head-title">
            <span className={`dot ${dotClass}`} />
            <button
              type="button"
              className="reader-head-name"
              onClick={() => !orphan && onOpenConfig(automationName)}
              disabled={orphan}
              title={orphan ? "Automation has been deleted" : "Open config"}
            >
              {automationName}
            </button>
            <span className="reader-head-sep">·</span>
            <span className="reader-head-status">{statusLabel}</span>
            {orphan && <span className="reader-head-tag">deleted</span>}
          </div>
          <div className="reader-head-sub">
            {new Date(run.startedAt).toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
            <span className="reader-head-dot">·</span>
            {formatDuration(run.startedAt, run.completedAt)}
            <span className="reader-head-dot">·</span>
            {formatTokens(run.inputTokens)} in / {formatTokens(run.outputTokens)} out
            {(run.toolCalls ?? 0) > 0 && (
              <>
                <span className="reader-head-dot">·</span>
                {run.toolCalls} tool {run.toolCalls === 1 ? "call" : "calls"}
              </>
            )}
            <span className="reader-head-dot">·</span>
            {relativeTime(run.startedAt)}
          </div>
        </div>
        <div className="reader-actions">
          {output && (
            <button type="button" className="btn" onClick={handleCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {!orphan && (
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => onRerun(automationName)}
            >
              Re-run
            </button>
          )}
        </div>
      </div>

      <div className="reader-body">
        {run.error ? (
          <div className="reader-error">
            <div className="reader-error-label">Error</div>
            <pre className="reader-error-body">{run.error}</pre>
            {output && (
              <>
                <div className="reader-error-label" style={{ marginTop: 14 }}>
                  Output before failure
                </div>
                <div
                  className="out-md"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }}
                />
              </>
            )}
          </div>
        ) : output ? (
          <div
            className="out-md"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
            dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }}
          />
        ) : run.status === "running" ? (
          <div className="reader-empty-desc">This run is still in progress.</div>
        ) : (
          <div className="reader-empty-desc">No output captured for this run.</div>
        )}

        {outputFiles.length > 0 && (
          <div className="reader-files">
            <div className="reader-section-label">Files produced</div>
            <ul className="reader-file-list">
              {outputFiles.map((f) => (
                <li key={f.id} className="reader-file">
                  {f.filename}
                </li>
              ))}
            </ul>
          </div>
        )}

        {activityLog.length > 0 && (
          <details className="reader-activity">
            <summary className="reader-section-label">
              Activity log ({activityLog.length} tool {activityLog.length === 1 ? "call" : "calls"})
            </summary>
            <ul className="reader-activity-list">
              {activityLog.map((tc) => (
                <li key={tc.id} className="reader-activity-item">
                  <span className={`dot ${tc.ok ? "dot-success" : "dot-failure"}`} />
                  <span className="reader-activity-name">{tc.name}</span>
                  <span className="reader-activity-ms">{tc.ms}ms</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="reader-footer-meta">
          <span>Iterations: {run.iterations ?? "-"}</span>
          <span>Tool calls: {run.toolCalls ?? "-"}</span>
          {run.stopReason && <span>Stop: {run.stopReason}</span>}
          <span>Run id: {run.id}</span>
        </div>
      </div>
    </div>
  );
}
