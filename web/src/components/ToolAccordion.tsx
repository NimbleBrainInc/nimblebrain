/**
 * ToolAccordion — the single surface for tool-call status, live and historical.
 *
 * It owns every state a tool call can be in:
 *   - running → present-tense verb + spinner ("Researching Acme Corp")
 *   - done    → past-tense verb + duration ("Researched · 120ms")
 *   - error   → warn-colored phrasing       ("Couldn't edit the source")
 *
 * There is no separate bottom "activity" indicator — the accordion is the
 * authoritative signal. `useMinDisplayTime` smooths the running→done flash so
 * very fast tools don't blink through their running state.
 *
 * Interaction model:
 *   - 1 call  → expanding the headline jumps straight to Input / Result.
 *   - N calls → expanding shows a list; each row is independently expandable.
 *   - Quiet display-detail → renders nothing.
 */

import { AlertCircle, Check, ChevronRight, Copy, Loader2 } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import type { ToolCallDisplay } from "../hooks/useChat";
import type { VisualStatus } from "../hooks/useMinDisplayTime";
import { useMinDisplayTime } from "../hooks/useMinDisplayTime";
import { formatDuration } from "../lib/format";
import type { DisplayDetail, Tone, ToolDescription } from "../lib/tool-display";
import { describeBatch } from "../lib/tool-display";

interface ToolAccordionProps {
  calls: ToolCallDisplay[];
  displayDetail: DisplayDetail;
  /**
   * True when this block's tools have all finished and the model is now
   * inferring on the results (streamingState === "analyzing"). Renders an
   * "Analyzing…" footer so the UI doesn't appear frozen between tool.done
   * and the next text.delta / tool.start.
   */
  pending?: boolean;
}

export const ToolAccordion = memo(function ToolAccordion({
  calls,
  displayDetail,
  pending = false,
}: ToolAccordionProps) {
  // Visual statuses smooth the running→done transition so quick tools don't flash.
  const visualStatuses = useMinDisplayTime(calls);
  const batch = useMemo(
    () => describeBatch(withVisualTone(calls, visualStatuses)),
    [calls, visualStatuses],
  );

  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  // `quiet` hides the whole accordion — including the pending footer. That's
  // intentional; in quiet mode the composer's "Analyzing..." label is the only
  // post-tool signal, which matches how quiet mode suppresses tool surfaces.
  if (displayDetail === "quiet" || batch.items.length === 0) return null;

  // Narrow via element lookup rather than length comparison so this stays
  // safe under noUncheckedIndexedAccess — the length check alone doesn't
  // prove items[0] is defined in stricter tsconfig modes.
  const firstItem = batch.items[0];
  const isSingle = batch.items.length === 1 && firstItem != null;
  // Promote the subject of a single-call batch next to the verb — turns
  // "Researching" into "Researching · Acme Corp" so the head reads like prose.
  const headSubject = isSingle ? firstItem.headSubject : null;

  return (
    <div className="tool-accordion" data-tone={batch.tone} data-expanded={expanded}>
      <button
        type="button"
        onClick={toggle}
        className="tool-accordion__head"
        aria-expanded={expanded}
      >
        <ToneIcon tone={batch.tone} />
        <span className="tool-accordion__verb">{batch.verbPhrase}</span>
        {headSubject && <span className="tool-accordion__subject">· {headSubject}</span>}
        {!isSingle && <span className="tool-accordion__count">{batch.items.length} steps</span>}
        {batch.totalMs != null && batch.tone !== "running" && (
          <span className="tool-accordion__ms">· {formatDuration(batch.totalMs)}</span>
        )}
        <ChevronRight className="tool-accordion__chev" style={{ width: 14, height: 14 }} />
      </button>

      {expanded && (
        <div className="tool-accordion__body">
          {isSingle ? (
            <ToolDetail item={firstItem} />
          ) : (
            batch.items.map((item) => <ToolRow key={item.id} item={item} />)
          )}
        </div>
      )}

      {/* Hold the footer back until the head has actually resolved to done/error.
          `useMinDisplayTime` keeps very fast tools visually in the running state
          for 600ms to prevent flashing; showing "Analyzing" during that window
          would put two spinners with conflicting copy on screen simultaneously
          (head: "Researching · Acme", footer: "Analyzing"). */}
      {pending && visualStatuses.every((vs) => vs.status !== "running") && (
        <div className="tool-accordion__pending" role="status" aria-live="polite">
          <Loader2
            className="tool-accordion__icon tool-accordion__icon--running"
            style={{ width: 12, height: 12 }}
          />
          <span>Analyzing</span>
        </div>
      )}
    </div>
  );
});

/**
 * One row in a multi-call accordion body. Collapsed by default; click to
 * reveal Input / Result.
 */
function ToolRow({ item }: { item: ToolDescription }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const hasDetail = item.input.length > 0 || item.resultText != null || item.errorText != null;

  return (
    <div className="tool-accordion__row" data-tone={item.tone} data-open={open}>
      <button
        type="button"
        onClick={toggle}
        className="tool-accordion__row-head"
        aria-expanded={open}
        disabled={!hasDetail}
      >
        <ToneIcon tone={item.tone} />
        <span className="tool-accordion__row-name">{item.name}</span>
        {item.summary && <span className="tool-accordion__row-summary">{item.summary}</span>}
        {item.durationMs != null && item.tone !== "running" && (
          <span className="tool-accordion__row-ms">{formatDuration(item.durationMs)}</span>
        )}
        {hasDetail && (
          <ChevronRight className="tool-accordion__chev" style={{ width: 12, height: 12 }} />
        )}
      </button>
      {open && hasDetail && (
        <div className="tool-accordion__row-body">
          <ToolDetail item={item} />
        </div>
      )}
    </div>
  );
}

/**
 * Rendered body of a single tool call: Input section + Result section (or
 * Error section on failure).
 */
function ToolDetail({ item }: { item: ToolDescription }) {
  return (
    <>
      {item.input.length > 0 && (
        <Section label="Input">
          <dl className="tool-accordion__kv">
            {item.input.map((field) => (
              <div key={field.key} className="tool-accordion__kv-row" data-kind={field.kind}>
                <dt className="tool-accordion__kv-k">{field.key}</dt>
                <dd className="tool-accordion__kv-v">
                  {field.kind === "long" ? (
                    <pre className="tool-accordion__pre">{field.display}</pre>
                  ) : (
                    field.display
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {item.errorText && (
        <Section label="Error" copyable={item.errorText}>
          <pre className="tool-accordion__pre tool-accordion__pre--error">{item.errorText}</pre>
        </Section>
      )}

      {item.resultText && !item.errorText && (
        <Section label="Result" copyable={item.resultText}>
          <pre className="tool-accordion__pre">{item.resultText}</pre>
        </Section>
      )}
    </>
  );
}

function Section({
  label,
  copyable,
  children,
}: {
  label: string;
  copyable?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="tool-accordion__section">
      <header className="tool-accordion__section-head">
        <span className="tool-accordion__section-label">{label}</span>
        {copyable != null && <CopyButton content={copyable} />}
      </header>
      {children}
    </section>
  );
}

type CopyState = "idle" | "copied" | "failed";

function CopyButton({ content }: { content: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const onClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("Clipboard API not available");
        }
        await navigator.clipboard.writeText(content);
        setState("copied");
      } catch {
        setState("failed");
      }
      window.setTimeout(() => setState("idle"), 1500);
    },
    [content],
  );
  return (
    <button
      type="button"
      onClick={onClick}
      className="tool-accordion__copy"
      aria-label="Copy to clipboard"
    >
      {state === "copied" ? (
        <>
          <Check style={{ width: 11, height: 11 }} /> copied
        </>
      ) : state === "failed" ? (
        <>
          <AlertCircle style={{ width: 11, height: 11 }} /> failed
        </>
      ) : (
        <>
          <Copy style={{ width: 11, height: 11 }} /> copy
        </>
      )}
    </button>
  );
}

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === "running") {
    return (
      <Loader2
        className="tool-accordion__icon tool-accordion__icon--running"
        style={{ width: 12, height: 12 }}
      />
    );
  }
  if (tone === "error") {
    return (
      <AlertCircle
        className="tool-accordion__icon tool-accordion__icon--error"
        style={{ width: 12, height: 12 }}
      />
    );
  }
  return <span className="tool-accordion__icon tool-accordion__icon--ok" aria-hidden />;
}

/**
 * Apply visual status (from useMinDisplayTime) back onto the call objects
 * before describing, so calls that just completed still show as running for
 * the minimum display duration.
 */
function withVisualTone(
  calls: ToolCallDisplay[],
  visualStatuses: VisualStatus[],
): ToolCallDisplay[] {
  if (visualStatuses.length !== calls.length) return calls;
  return calls.map((call, i) => {
    const vs = visualStatuses[i];
    if (vs.status === call.status) return call;
    return { ...call, status: vs.status };
  });
}
