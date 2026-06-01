import { useAction } from "@nimblebrain/synapse/react";
import { useState } from "react";
import { BackArrowIcon } from "../icons.tsx";
import { renderMarkdown } from "../markdown.ts";
import type { AutomationRun, AutomationSummary } from "../types.ts";
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
  const action = useAction();
  const [copied, setCopied] = useState(false);

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

  const automationName = automation?.name || run.automationId || "unknown";
  const dotClass = statusDotClass(run.status, true);
  const statusLabel = STATUS_LABEL[run.status] || run.status;
  const orphan = !automation;
  // Pre-0.x records were capped at 500 chars on disk; show a small note on
  // those legacy runs so it's clear why the output looks chopped.
  const legacyTruncated = !run.error && (run.resultPreview?.length ?? 0) === 500;

  async function handleCopy() {
    if (!run?.resultPreview) return;
    try {
      await navigator.clipboard.writeText(run.resultPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable in some contexts; silent
    }
  }

  function handleOpenConversation() {
    if (!run?.conversationId) return;
    action("openConversation", { id: run.conversationId });
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
            {run.toolCalls > 0 && (
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
          {run.resultPreview && (
            <button type="button" className="btn" onClick={handleCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {!orphan && (
            <button type="button" className="btn" onClick={() => onRerun(automationName)}>
              Re-run
            </button>
          )}
          {run.conversationId && (
            <button type="button" className="btn btn-accent" onClick={handleOpenConversation}>
              Open conversation →
            </button>
          )}
        </div>
      </div>

      <div className="reader-body">
        {run.error ? (
          <div className="reader-error">
            <div className="reader-error-label">Error</div>
            <pre className="reader-error-body">{run.error}</pre>
            {run.resultPreview && (
              <>
                <div className="reader-error-label" style={{ marginTop: 14 }}>
                  Output before failure
                </div>
                <div
                  className="out-md"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(run.resultPreview),
                  }}
                />
              </>
            )}
          </div>
        ) : run.resultPreview ? (
          <>
            <div
              className="out-md"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify in renderMarkdown
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(run.resultPreview),
              }}
            />
            {legacyTruncated && (
              <div className="reader-truncation-note">
                This run is from an older build that capped output at 500 chars. Re-run for the full
                output.
              </div>
            )}
          </>
        ) : run.status === "running" ? (
          <div className="reader-empty-desc">This run is still in progress.</div>
        ) : (
          <div className="reader-empty-desc">No output captured for this run.</div>
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
