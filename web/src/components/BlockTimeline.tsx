/**
 * BlockTimeline — render an assistant turn's blocks inline, in stream order.
 *
 * First principles:
 *
 *   1. **Faithful timeline.** Each phase the LLM emits renders at the spot
 *      it streamed. No per-turn aggregation, no hoisting.
 *
 *   2. **One chip per phase of work.** A "phase" is a contiguous run of
 *      reasoning + tool blocks with no text between. Reasoning followed by
 *      tools (the natural think→act pattern) reads as one collapsible
 *      activity, not two stacked chips. Text always breaks the phase —
 *      "preamble text → tools → final text" stays three distinct elements.
 *
 *   3. **Blocks are self-stating.** A chip is muted when its work is
 *      settled and active when something inside it is in flight. There is
 *      no separate turn-level status surface.
 *
 *   4. **One live cursor for the gaps.** When the engine is mid-flight but
 *      no block is currently absorbing the state (initial warm-up,
 *      preparing the next tool, post-tool analyzing), a small `<LiveCursor>`
 *      at the bottom of the message body covers the transition. The
 *      moment the next block starts streaming, the block's own active
 *      state takes over and the cursor steps aside.
 *
 * Within a phase: consecutive tool blocks whose calls share a single tool
 * name fold into one tool row with `×N`. Reasoning rows each keep their
 * own row. The chip's body lists the rows in stream order.
 */

import { AlertCircle, Check, ChevronRight, Copy, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import type {
  ContentBlock,
  PreparingTool,
  StreamingState,
  ToolCallDisplay,
} from "../hooks/useChat";
import { useMinDisplayTime, type VisualStatus } from "../hooks/useMinDisplayTime";
import { formatDuration, stripServerPrefix } from "../lib/format";
import {
  aggregateGroup,
  describeCall,
  type DisplayDetail,
  type GroupDescription,
  type Tone,
  type ToolDescription,
} from "../lib/tool-display";
import { InlineAppView } from "./InlineAppView";
import { ResourceLinkView } from "./ResourceLinkView";

// ─────────────────────────────────────────────────────────────────────────────
// Data model
// ─────────────────────────────────────────────────────────────────────────────

/** One row inside an `activity` segment's chip body. */
type ActivityRow =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; calls: ToolCallDisplay[] };

/**
 * One renderable item after segmentation + within-segment tool folding.
 *
 * - `text` — single text block (whole-paragraph prose).
 * - `activity` — a contiguous run of reasoning + tool blocks with no text
 *   between, presented as ONE chip whose body lists each `rows[]` entry.
 */
type TimelineItem = { kind: "text"; text: string } | { kind: "activity"; rows: ActivityRow[] };

/**
 * Walk `blocks[]`, partition at text boundaries, and within each activity
 * segment fold consecutive same-name tool blocks into one tool row.
 *
 * Empty reasoning blocks (zero-length text) and empty tool blocks are
 * dropped so the timeline doesn't render placeholders for nothing.
 */
function foldBlocks(blocks: ReadonlyArray<ContentBlock>): TimelineItem[] {
  const items: TimelineItem[] = [];
  let rows: ActivityRow[] = [];

  const flush = () => {
    if (rows.length === 0) return;
    items.push({ kind: "activity", rows });
    rows = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      flush();
      if (block.text.length > 0) items.push({ kind: "text", text: block.text });
      continue;
    }
    if (block.type === "reasoning") {
      if (block.text.length === 0) continue;
      rows.push({ kind: "reasoning", text: block.text });
      continue;
    }
    // tool block
    if (block.toolCalls.length === 0) continue;
    const sharedName = sameNameAcross(block.toolCalls);
    const prev = rows[rows.length - 1];
    if (
      sharedName !== null &&
      prev?.kind === "tool" &&
      prev.name === sharedName &&
      prev.name !== ""
    ) {
      prev.calls.push(...block.toolCalls);
    } else {
      rows.push({
        kind: "tool",
        name: sharedName ?? "",
        calls: [...block.toolCalls],
      });
    }
  }
  flush();
  return items;
}

function sameNameAcross(calls: ReadonlyArray<ToolCallDisplay>): string | null {
  if (calls.length === 0) return null;
  const first = calls[0].name;
  for (const c of calls) if (c.name !== first) return null;
  return first;
}

// ─────────────────────────────────────────────────────────────────────────────
// BlockTimeline — top-level iterator
// ─────────────────────────────────────────────────────────────────────────────

interface BlockTimelineProps {
  blocks: ReadonlyArray<ContentBlock>;
  /** True for the currently-streaming assistant message. */
  isCurrentMessage: boolean;
  streamingState: StreamingState;
  preparingTool: PreparingTool | null;
  displayDetail: DisplayDetail;
}

export function BlockTimeline({
  blocks,
  isCurrentMessage,
  streamingState,
  preparingTool,
  displayDetail,
}: BlockTimelineProps) {
  const items = useMemo(() => foldBlocks(blocks), [blocks]);

  return (
    <>
      {items.map((item, idx) => {
        const isLast = idx === items.length - 1;
        const isTailDelta = isCurrentMessage && isLast && streamingState === "streaming";
        if (item.kind === "text") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: items derived from append-only blocks; identity by position is stable
            <div key={`text:${idx}`} className="min-h-[1em]">
              <Streamdown
                className="streamdown-container presence-assistant-message"
                isAnimating={isTailDelta}
              >
                {item.text}
              </Streamdown>
            </div>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: same as above
          <div key={`activity:${idx}`} className="flex flex-col gap-3">
            <ActivityChip
              rows={item.rows}
              isReasoningTailStreaming={isTailDelta && lastRow(item.rows)?.kind === "reasoning"}
              displayDetail={displayDetail}
            />
            <ToolWidgets calls={collectToolCalls(item.rows)} />
          </div>
        );
      })}
      {isCurrentMessage && (
        <LiveCursor streamingState={streamingState} preparingTool={preparingTool} />
      )}
    </>
  );
}

function lastRow(rows: ReadonlyArray<ActivityRow>): ActivityRow | undefined {
  return rows[rows.length - 1];
}

function collectToolCalls(rows: ReadonlyArray<ActivityRow>): ToolCallDisplay[] {
  const out: ToolCallDisplay[] = [];
  for (const r of rows) if (r.kind === "tool") out.push(...r.calls);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live cursor — covers the gaps between blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render only when the engine is mid-flight but no block is absorbing the
 * state. `streamingState` tells us which case we're in:
 *
 *   - `streaming` → text/reasoning block receiving deltas; that block's own
 *     active state covers it → cursor hides.
 *   - `working`   → a tool call has status="running"; the chip spins →
 *     cursor hides.
 *   - `thinking`  → pre-first-block warm-up; cursor shows "Thinking…".
 *   - `preparing` → tool being built server-side, no tool block pushed yet;
 *     cursor shows "Calling X…".
 *   - `analyzing` → post-tool-result digest before next reasoning/text;
 *     cursor shows "Analyzing…".
 *   - `null`      → turn done; cursor hides.
 */
function LiveCursor({
  streamingState,
  preparingTool,
}: {
  streamingState: StreamingState;
  preparingTool: PreparingTool | null;
}) {
  const label = liveCursorLabel(streamingState, preparingTool);
  if (label === null) return null;
  return (
    <div className="live-cursor" role="status" aria-live="polite">
      <Loader2 className="live-cursor__spinner" style={{ width: 12, height: 12 }} />
      <span className="live-cursor__label">{label}</span>
    </div>
  );
}

function liveCursorLabel(
  streamingState: StreamingState,
  preparingTool: PreparingTool | null,
): string | null {
  switch (streamingState) {
    case "thinking":
      return "Thinking…";
    case "preparing":
      return preparingTool ? `Calling ${stripServerPrefix(preparingTool.name)}…` : "Calling…";
    case "analyzing":
      return "Analyzing…";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity chip — one collapsible widget per phase of work
// ─────────────────────────────────────────────────────────────────────────────

interface ActivityChipProps {
  rows: ReadonlyArray<ActivityRow>;
  /** True when the trailing row is reasoning still receiving deltas. */
  isReasoningTailStreaming: boolean;
  displayDetail: DisplayDetail;
}

function ActivityChip({ rows, isReasoningTailStreaming, displayDetail }: ActivityChipProps) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  // Flatten every tool call across the segment so useMinDisplayTime gets a
  // stable list, then weave smoothed statuses back into descriptions for
  // tone / label derivation. Without smoothing, a 2ms tool flashes
  // running→done too briefly to register.
  const allCalls = useMemo(() => collectToolCalls(rows), [rows]);
  const visualStatuses = useMinDisplayTime(allCalls);
  const smoothedCalls = useMemo(
    () => applyVisualStatuses(allCalls, visualStatuses),
    [allCalls, visualStatuses],
  );
  const smoothedRows = useMemo(
    () => weaveSmoothed(rows, allCalls, smoothedCalls),
    [rows, allCalls, smoothedCalls],
  );
  const descriptions = useMemo(() => smoothedCalls.map(describeCall), [smoothedCalls]);
  const group = useMemo(() => aggregateGroup(descriptions), [descriptions]);

  if (displayDetail === "quiet") return null;

  // Reasoning-tail streaming counts as "running" for the chip even though
  // no tool is in flight — the only piece of state the aggregator can't
  // see on its own (it knows tools, not reasoning).
  const tone: Tone = group.tone === "running" || isReasoningTailStreaming ? "running" : group.tone;
  const head = chipHead(rows, group, isReasoningTailStreaming);
  const hasBody = rows.some((r) => r.kind === "reasoning" || r.kind === "tool");
  const isSingleRow = rows.length === 1;

  return (
    <div className="turn-pill" data-tone={tone} data-expanded={open}>
      <button
        type="button"
        onClick={toggle}
        className="turn-pill__head"
        aria-expanded={open}
        disabled={!hasBody}
      >
        <HeadIcon tone={tone} />
        <span className="turn-pill__label">{head.label}</span>
        {head.subject && <span className="turn-pill__row-subject">· {head.subject}</span>}
        {head.count > 1 && <span className="turn-pill__row-count">×{head.count}</span>}
        {tone !== "running" && head.totalMs != null && (
          <span className="turn-pill__ms">· {formatDuration(head.totalMs)}</span>
        )}
        {head.tokenLabel && <span className="turn-pill__ms">· {head.tokenLabel}</span>}
        {hasBody && <ChevronRight className="turn-pill__chev" style={{ width: 14, height: 14 }} />}
      </button>
      {open && hasBody && (
        <div className="turn-pill__body">
          {isSingleRow ? (
            <SingleRowBody row={smoothedRows[0]} />
          ) : (
            smoothedRows.map((row, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows within a segment are append-only and don't reorder
              <ActivityRowView key={`row:${idx}`} row={row} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface ChipHead {
  label: string;
  subject: string | null;
  count: number;
  totalMs: number | null;
  tokenLabel: string | null;
}

/**
 * Compose the chip's collapsed-state label from a `GroupDescription` plus
 * the reasoning context the aggregator doesn't see (token count, the
 * streaming-tail flag). This function does no aggregation of its own —
 * it picks tense and assembles strings.
 */
function chipHead(
  rows: ReadonlyArray<ActivityRow>,
  group: GroupDescription,
  isReasoningTailStreaming: boolean,
): ChipHead {
  const totalReasoningChars = rows.reduce(
    (acc, r) => (r.kind === "reasoning" ? acc + r.text.length : acc),
    0,
  );

  // Pure reasoning — no tool calls in this segment.
  if (group.count === 0) {
    return {
      label: isReasoningTailStreaming ? "Thinking…" : "Thought",
      subject: null,
      count: 0,
      totalMs: null,
      tokenLabel: isReasoningTailStreaming ? null : approximateTokenLabel(totalReasoningChars),
    };
  }

  const running = group.tone === "running" || isReasoningTailStreaming;
  const verb = running ? group.verbPresent : group.verb;
  return {
    label: group.object ? `${verb} ${group.object}` : verb,
    subject: group.subject,
    count: group.count,
    totalMs: group.totalMs,
    tokenLabel: approximateTokenLabel(totalReasoningChars),
  };
}

/** Render one segment-body row when there's only ONE row — skip the
 *  nested row chrome and render the content directly. Click-to-expand is
 *  already provided by the chip head. */
function SingleRowBody({ row }: { row: ActivityRow }) {
  if (row.kind === "reasoning") {
    return (
      <div className="turn-pill__reasoning-wrap">
        <div className="turn-pill__reasoning">{row.text}</div>
      </div>
    );
  }
  // tool
  return (
    <div className="turn-pill__tool-wrap">
      {row.calls.length === 1 ? (
        <ToolCallDetail item={describeCall(row.calls[0])} />
      ) : (
        row.calls.map((c) => <ToolCallRow key={c.id} item={describeCall(c)} />)
      )}
    </div>
  );
}

/** Render one row in a multi-row segment body — each row is its own
 *  expandable mini-section so the user can drill into reasoning text or
 *  per-call detail without losing the surrounding context. */
function ActivityRowView({ row }: { row: ActivityRow }) {
  if (row.kind === "reasoning") return <ReasoningRow text={row.text} />;
  return <ToolRow calls={row.calls} />;
}

function ReasoningRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const tokenLabel = approximateTokenLabel(text.length);
  return (
    <div className="turn-pill__row" data-tone="ok" data-open={open}>
      <button type="button" onClick={toggle} className="turn-pill__row-head" aria-expanded={open}>
        <RowIcon tone="ok" />
        <span className="turn-pill__row-name">Thought</span>
        {tokenLabel && <span className="turn-pill__row-subject">· {tokenLabel}</span>}
        <ChevronRight className="turn-pill__chev" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="turn-pill__row-body">
          <div className="turn-pill__reasoning">{text}</div>
        </div>
      )}
    </div>
  );
}

function ToolRow({ calls }: { calls: ReadonlyArray<ToolCallDisplay> }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const descriptions = useMemo(() => calls.map(describeCall), [calls]);
  const group = useMemo(() => aggregateGroup(descriptions), [descriptions]);
  const verb = group.tone === "running" ? group.verbPresent : group.verb;
  const label = group.object ? `${verb} ${group.object}` : verb;
  return (
    <div className="turn-pill__row" data-tone={group.tone} data-open={open}>
      <button type="button" onClick={toggle} className="turn-pill__row-head" aria-expanded={open}>
        <RowIcon tone={group.tone} />
        <span className="turn-pill__row-name">{label}</span>
        {group.subject && <span className="turn-pill__row-subject">· {group.subject}</span>}
        {group.count > 1 && <span className="turn-pill__row-count">×{group.count}</span>}
        {group.tone !== "running" && group.totalMs != null && (
          <span className="turn-pill__row-ms">· {formatDuration(group.totalMs)}</span>
        )}
        <ChevronRight className="turn-pill__chev" style={{ width: 12, height: 12 }} />
      </button>
      {open && (
        <div className="turn-pill__row-body">
          {descriptions.length === 1 ? (
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
        {/* Always show *something* — input summary when there is one,
            otherwise the tool name. A no-input call (e.g. `current_user()`)
            still needs to identify itself; just a dot + duration tells the
            reader nothing about what ran. */}
        <span className="turn-pill__call-summary">{item.summary ?? item.name}</span>
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
  children: ReactNode;
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
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API not available");
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
// Tool widgets (inline app views + resource-link cards)
// ─────────────────────────────────────────────────────────────────────────────

function ToolWidgets({ calls }: { calls: ReadonlyArray<ToolCallDisplay> }) {
  const widgets = calls.filter((tc) => tc.resourceUri && tc.status === "done" && tc.appName);
  const resourceLinkCalls = calls.filter(
    (tc) => tc.status === "done" && tc.appName && tc.resourceLinks && tc.resourceLinks.length > 0,
  );
  if (widgets.length === 0 && resourceLinkCalls.length === 0) return null;
  return (
    <>
      {widgets.map((tc) => (
        // Pass the full ui:// URI through — InlineAppView strips the scheme
        // and forwards everything after as the resource path. The legacy
        // regex `/^ui:\/\/[^/]+\/(.+)$/` dropped the first segment on the
        // assumption it was a namespace prefix, which breaks two-segment
        // URIs like `ui://<state>/<method>` where the first segment is
        // load-bearing (Reboot's convention for state-scoped UI methods).
        <InlineAppView
          key={tc.id}
          appName={tc.appName!}
          resourceUri={tc.resourceUri!}
          toolResult={{ tool: tc.name, result: tc.result }}
        />
      ))}
      {resourceLinkCalls.flatMap((tc) =>
        tc.resourceLinks!.map((link) => (
          <ResourceLinkView
            key={`${tc.id}:${link.uri}`}
            appName={tc.appName!}
            uri={link.uri}
            name={link.name}
            mimeType={link.mimeType}
            description={link.description}
          />
        )),
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared chrome icons
// ─────────────────────────────────────────────────────────────────────────────

function HeadIcon({ tone }: { tone: Tone }) {
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

function RowIcon({ tone }: { tone: Tone }) {
  return <HeadIcon tone={tone} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function applyVisualStatuses(
  calls: ReadonlyArray<ToolCallDisplay>,
  visualStatuses: ReadonlyArray<VisualStatus>,
): ToolCallDisplay[] {
  if (visualStatuses.length !== calls.length) return [...calls];
  return calls.map((c, i) => {
    const vs = visualStatuses[i];
    if (!vs || vs.status === c.status) return c;
    return { ...c, status: vs.status };
  });
}

/**
 * Rebuild the rows array using smoothed call objects, preserving structure
 * (reasoning rows pass through; tool rows get smoothed calls in the same
 * order they appeared in the flattened list).
 */
function weaveSmoothed(
  rows: ReadonlyArray<ActivityRow>,
  origCalls: ReadonlyArray<ToolCallDisplay>,
  smoothed: ReadonlyArray<ToolCallDisplay>,
): ActivityRow[] {
  if (smoothed.length !== origCalls.length) return [...rows];
  const byId = new Map<string, ToolCallDisplay>();
  for (let i = 0; i < origCalls.length; i++) byId.set(origCalls[i].id, smoothed[i]);
  return rows.map((r) =>
    r.kind === "tool"
      ? { kind: "tool", name: r.name, calls: r.calls.map((c) => byId.get(c.id) ?? c) }
      : r,
  );
}

/** Same heuristic as the old reasoning row — 4 chars/token, k-form ≥2500. */
function approximateTokenLabel(charCount: number): string {
  if (charCount === 0) return "";
  const tokens = Math.round(charCount / 4);
  if (tokens >= 2500) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}
