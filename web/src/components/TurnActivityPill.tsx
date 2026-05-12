/**
 * TurnActivityPill — the single status + tool surface for an assistant turn.
 *
 * Replaces the old per-block `ToolAccordion`, the composer footer label, the
 * inline "Calling X…" placeholder, and the standalone ReasoningBlock chevron.
 * Everything an assistant turn needs to say about its activity goes here.
 *
 * Three disclosure levels:
 *   L1  one-line head, morphs through streamingState (thinking → preparing →
 *       working → analyzing → done). One spinner per turn, never two.
 *   L2  timeline drawer — tool groups (same tool name folded across the
 *       whole turn) interleaved with reasoning rows in temporal order.
 *   L3  per-call detail (Input / Result / Error) — unchanged from before.
 *
 * Tone policy:
 *   - The head never goes red. Child failures live inside L2/L3.
 *   - Turn-level success/failure is signaled at the message level
 *     (`msg.error` / `msg.stopReason` in MessageList) — not by rolling child
 *     errors up to this head.
 */

import { AlertCircle, Check, ChevronRight, Copy, Loader2 } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import type {
  ContentBlock,
  PreparingTool,
  StreamingState,
  ToolCallDisplay,
} from "../hooks/useChat";
import type { VisualStatus } from "../hooks/useMinDisplayTime";
import { useMinDisplayTime } from "../hooks/useMinDisplayTime";
import { stripServerPrefix } from "../lib/format";
import { formatDuration } from "../lib/format";
import type {
  DisplayDetail,
  TimelineEntry,
  Tone,
  ToolDescription,
  TurnSummary,
} from "../lib/tool-display";
import { describeCall, describeTurn, groupTurn } from "../lib/tool-display";
import { PRESENT_TENSE } from "../lib/tool-display/verbs";

interface TurnActivityPillProps {
  blocks: ContentBlock[] | undefined;
  streamingState: StreamingState;
  preparingTool: PreparingTool | null;
  /** True for the message that's currently streaming; gates the live label. */
  isCurrentTurn: boolean;
  displayDetail: DisplayDetail;
}

export const TurnActivityPill = memo(function TurnActivityPill({
  blocks,
  streamingState,
  preparingTool,
  isCurrentTurn,
  displayDetail,
}: TurnActivityPillProps) {
  const entries = useMemo(() => groupTurn(blocks ?? []), [blocks]);

  // Flatten every call across the turn so useMinDisplayTime gets a stable list,
  // then thread the smoothed statuses back into per-entry copies before
  // describing. Without this, a 2ms tool flashes "running → done" too fast to
  // register.
  const allCalls = useMemo(() => flattenCalls(entries), [entries]);
  const visualStatuses = useMinDisplayTime(allCalls);
  const adjustedEntries = useMemo(
    () => applyVisualStatuses(entries, allCalls, visualStatuses),
    [entries, allCalls, visualStatuses],
  );
  const summary = useMemo(() => describeTurn(adjustedEntries), [adjustedEntries]);

  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  if (displayDetail === "quiet") return null;

  // Visibility: nothing to show when the turn produced no tool activity AND
  // we aren't actively narrating a pre-tool state (thinking / preparing).
  const liveLeadingState =
    isCurrentTurn && (streamingState === "thinking" || streamingState === "preparing");
  if (summary.totalCalls === 0 && !liveLeadingState) return null;

  const head = headDescription({
    summary,
    streamingState,
    preparingTool,
    isCurrentTurn,
  });
  const showChevron = entries.length > 0;

  return (
    <div className="turn-pill" data-tone={head.tone} data-expanded={expanded}>
      <button
        type="button"
        onClick={toggle}
        className="turn-pill__head"
        aria-expanded={expanded}
        disabled={!showChevron}
      >
        <HeadIcon tone={head.tone} />
        <span className="turn-pill__label">{head.text}</span>
        {summary.totalCalls > 0 && (
          <span className="turn-pill__count">
            · {summary.totalCalls} {summary.totalCalls === 1 ? "step" : "steps"}
          </span>
        )}
        {!head.spinning && summary.totalMs != null && (
          <span className="turn-pill__ms">· {formatDuration(summary.totalMs)}</span>
        )}
        {showChevron && (
          <ChevronRight className="turn-pill__chev" style={{ width: 14, height: 14 }} />
        )}
      </button>

      {expanded && entries.length > 0 && (
        <div className="turn-pill__body">
          {adjustedEntries.map((entry, idx) =>
            entry.kind === "tool" ? (
              <ToolGroupRow key={`tool:${entry.name}:${idx}`} entry={entry} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: reasoning entries don't reorder; index is stable
              <ReasoningRow key={`reasoning:${idx}`} text={entry.text} />
            ),
          )}
        </div>
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Head label derivation
// ─────────────────────────────────────────────────────────────────────────────

interface HeadDescription {
  tone: "running" | "neutral";
  spinning: boolean;
  text: string;
}

interface HeadInputs {
  summary: TurnSummary;
  streamingState: StreamingState;
  preparingTool: PreparingTool | null;
  isCurrentTurn: boolean;
}

function headDescription({
  summary,
  streamingState,
  preparingTool,
  isCurrentTurn,
}: HeadInputs): HeadDescription {
  const isLive =
    isCurrentTurn &&
    (streamingState === "thinking" ||
      streamingState === "preparing" ||
      streamingState === "working" ||
      streamingState === "analyzing");
  const spinning = isLive || summary.running;

  // Live pre-tool states — these fire before any tool call has landed in the
  // turn (or between calls when the next one is being planned).
  if (isCurrentTurn && streamingState === "preparing" && preparingTool) {
    return {
      tone: "running",
      spinning: true,
      text: `Calling ${stripServerPrefix(preparingTool.name)}…`,
    };
  }
  if (isCurrentTurn && streamingState === "analyzing") {
    return { tone: "running", spinning: true, text: "Analyzing…" };
  }
  if (summary.totalCalls === 0) {
    // Only the bare "Thinking…" state — covered by the early visibility gate
    // unless we're a live turn.
    return { tone: "running", spinning: true, text: "Thinking…" };
  }

  // Tool activity exists — pick tense from running-ness.
  const subject = summary.topSubject ? ` ${summary.topSubject}` : "";
  if (spinning) {
    return {
      tone: "running",
      spinning: true,
      text: `${summary.dominantVerbPresent}${subject}`,
    };
  }
  return {
    tone: "neutral",
    spinning: false,
    text: `${summary.dominantVerb}${subject}`,
  };
}

function HeadIcon({ tone }: { tone: "running" | "neutral" }) {
  if (tone === "running") {
    return (
      <Loader2
        className="turn-pill__icon turn-pill__icon--running"
        style={{ width: 12, height: 12 }}
      />
    );
  }
  return <span className="turn-pill__icon turn-pill__icon--ok" aria-hidden />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline rows
// ─────────────────────────────────────────────────────────────────────────────

function ToolGroupRow({ entry }: { entry: Extract<TimelineEntry, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const descriptions = useMemo(() => entry.calls.map(describeCall), [entry.calls]);
  const tone: Tone = descriptions.some((d) => d.tone === "running")
    ? "running"
    : descriptions.some((d) => d.tone === "error")
      ? "error"
      : "ok";
  const totalMs = useMemo(() => sumDurations(descriptions), [descriptions]);
  const verbPhrase = useMemo(() => groupVerbPhrase(descriptions, tone), [descriptions, tone]);
  const headSubject = useMemo(() => firstSubject(descriptions), [descriptions]);
  const count = descriptions.length;

  return (
    <div className="turn-pill__row" data-tone={tone} data-open={open}>
      <button type="button" onClick={toggle} className="turn-pill__row-head" aria-expanded={open}>
        <RowIcon tone={tone} />
        <span className="turn-pill__row-name">{verbPhrase}</span>
        {headSubject && <span className="turn-pill__row-subject">· {headSubject}</span>}
        {count > 1 && <span className="turn-pill__row-count">×{count}</span>}
        {tone !== "running" && totalMs != null && (
          <span className="turn-pill__row-ms">· {formatDuration(totalMs)}</span>
        )}
        <ChevronRight className="turn-pill__chev" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="turn-pill__row-body">
          {count === 1 ? (
            <ToolCallDetail item={descriptions[0]} />
          ) : (
            descriptions.map((d) => <ToolCallRow key={d.id} item={d} />)
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ item }: { item: ToolDescription }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const hasDetail = item.input.length > 0 || item.resultText != null || item.errorText != null;
  return (
    <div className="turn-pill__call" data-tone={item.tone} data-open={open}>
      <button
        type="button"
        onClick={toggle}
        className="turn-pill__call-head"
        aria-expanded={open}
        disabled={!hasDetail}
      >
        <RowIcon tone={item.tone} />
        {item.summary && <span className="turn-pill__call-summary">{item.summary}</span>}
        {item.tone !== "running" && item.durationMs != null && (
          <span className="turn-pill__call-ms">{formatDuration(item.durationMs)}</span>
        )}
        {hasDetail && (
          <ChevronRight className="turn-pill__chev" style={{ width: 11, height: 11 }} />
        )}
      </button>
      {open && hasDetail && (
        <div className="turn-pill__call-body">
          <ToolCallDetail item={item} />
        </div>
      )}
    </div>
  );
}

function ReasoningRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const tokenLabel = approximateTokenLabel(text.length);
  return (
    <div className="turn-pill__row turn-pill__row--reasoning" data-open={open}>
      <button type="button" onClick={toggle} className="turn-pill__row-head" aria-expanded={open}>
        <span className="turn-pill__icon turn-pill__icon--ok" aria-hidden />
        <span className="turn-pill__row-name">Thought</span>
        {tokenLabel && <span className="turn-pill__row-subject">· {tokenLabel}</span>}
        <ChevronRight className="turn-pill__chev" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="turn-pill__row-body">
          <pre className="turn-pill__reasoning">{text}</pre>
        </div>
      )}
    </div>
  );
}

function RowIcon({ tone }: { tone: Tone }) {
  if (tone === "running") {
    return (
      <Loader2
        className="turn-pill__icon turn-pill__icon--running"
        style={{ width: 12, height: 12 }}
      />
    );
  }
  if (tone === "error") {
    return (
      <AlertCircle
        className="turn-pill__icon turn-pill__icon--error"
        style={{ width: 12, height: 12 }}
      />
    );
  }
  return <span className="turn-pill__icon turn-pill__icon--ok" aria-hidden />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-call detail (Input / Result / Error) — kept as the existing pattern.
// ─────────────────────────────────────────────────────────────────────────────

function ToolCallDetail({ item }: { item: ToolDescription }) {
  return (
    <>
      {item.input.length > 0 && (
        <Section label="Input">
          <dl className="turn-pill__kv">
            {item.input.map((field) => (
              <div key={field.key} className="turn-pill__kv-row" data-kind={field.kind}>
                <dt className="turn-pill__kv-k">{field.key}</dt>
                <dd className="turn-pill__kv-v">
                  {field.kind === "long" ? (
                    <pre className="turn-pill__pre">{field.display}</pre>
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
          <pre className="turn-pill__pre turn-pill__pre--error">{item.errorText}</pre>
        </Section>
      )}

      {item.resultText && !item.errorText && (
        <Section label="Result" copyable={item.resultText}>
          <pre className="turn-pill__pre">{item.resultText}</pre>
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
    <section className="turn-pill__section">
      <header className="turn-pill__section-head">
        <span className="turn-pill__section-label">{label}</span>
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
      className="turn-pill__copy"
      aria-label={state === "failed" ? "Copy failed" : "Copy to clipboard"}
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function flattenCalls(entries: ReadonlyArray<TimelineEntry>): ToolCallDisplay[] {
  const out: ToolCallDisplay[] = [];
  for (const e of entries) {
    if (e.kind === "tool") {
      for (const c of e.calls) out.push(c);
    }
  }
  return out;
}

/**
 * Overlay smoothed visual statuses back onto the entries' calls. Tools that
 * just completed stay visually `running` for the min-display grace so they
 * don't flash.
 */
function applyVisualStatuses(
  entries: ReadonlyArray<TimelineEntry>,
  allCalls: ReadonlyArray<ToolCallDisplay>,
  visualStatuses: ReadonlyArray<VisualStatus>,
): TimelineEntry[] {
  if (visualStatuses.length !== allCalls.length) return [...entries];
  const byId = new Map<string, VisualStatus>();
  for (let i = 0; i < allCalls.length; i++) {
    byId.set(allCalls[i].id, visualStatuses[i]);
  }
  return entries.map((e) => {
    if (e.kind !== "tool") return e;
    const calls = e.calls.map((c) => {
      const vs = byId.get(c.id);
      if (!vs || vs.status === c.status) return c;
      return { ...c, status: vs.status };
    });
    return { kind: "tool", name: e.name, calls };
  });
}

function sumDurations(items: ReadonlyArray<ToolDescription>): number | null {
  let any = false;
  let total = 0;
  for (const it of items) {
    if (typeof it.durationMs === "number") {
      any = true;
      total += it.durationMs;
    }
  }
  return any ? total : null;
}

/**
 * Verb phrase for a tool group row. All calls share a name (and thus a verb);
 * tense comes from the group's tone. Error tone never reaches this row (the
 * group row never goes red — error tone here would imply *every* call in the
 * group failed, in which case we still show the per-call red dot inside).
 */
/**
 * Verb phrase for a tool-group row: present tense while running, past tense at
 * rest, paired with the tool name's object. No article — "Ran listtransactions"
 * not "Ran the listtransactions" — because the ×N count and duration suffix
 * already read awkwardly with one.
 */
function groupVerbPhrase(items: ReadonlyArray<ToolDescription>, tone: Tone): string {
  if (items.length === 0) return "";
  const sample = items[0];
  const verb = tone === "running" ? (PRESENT_TENSE[sample.verb] ?? sample.verb) : sample.verb;
  return sample.object ? `${verb} ${sample.object}` : verb;
}

function firstSubject(items: ReadonlyArray<ToolDescription>): string | null {
  for (const it of items) {
    if (it.headSubject) return it.headSubject;
  }
  return null;
}

/** Same heuristic as the old ReasoningBlock — 4 chars/token, k-form ≥2500. */
function approximateTokenLabel(charCount: number): string {
  if (charCount === 0) return "";
  const tokens = Math.round(charCount / 4);
  if (tokens >= 2500) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}
