/**
 * BlockTimeline — render an assistant turn's blocks inline, in stream order.
 *
 * First principles:
 *
 *   1. **Faithful timeline.** Each block the LLM emits (text, reasoning,
 *      tool) gets its own element at the spot it streamed. No per-turn
 *      aggregation, no hoisting. The summary IS the order.
 *
 *   2. **Blocks are self-stating.** Each non-text block renders as a chip
 *      that carries its own status: active spinner while the work is
 *      happening, muted/clickable once settled. There is no separate
 *      "turn-level status" surface.
 *
 *   3. **One live cursor for the gaps.** When the engine is mid-flight but
 *      no block is currently absorbing the state (initial warm-up,
 *      preparing the next tool, post-tool analyzing), a small <LiveCursor>
 *      at the bottom of the message body covers the transition. The
 *      moment the next block starts streaming, the block's own active
 *      state takes over and the cursor steps aside.
 *
 * Consecutive tool blocks whose calls all share a single tool name fold
 * into one `<ToolChip>` row with a `×N` count — common bulk patterns stay
 * compact without crossing reasoning/text boundaries (which would
 * misrepresent the timeline).
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
  describeCall,
  type DisplayDetail,
  type Tone,
  type ToolDescription,
} from "../lib/tool-display";
import { PRESENT_TENSE } from "../lib/tool-display/verbs";
import { InlineAppView } from "./InlineAppView";
import { ResourceLinkView } from "./ResourceLinkView";

// ─────────────────────────────────────────────────────────────────────────────
// Timeline iterator
// ─────────────────────────────────────────────────────────────────────────────

/** One renderable item after consecutive-same-name tool folding. */
type TimelineItem =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; calls: ToolCallDisplay[] };

/**
 * Fold consecutive tool blocks whose calls share a single tool name into one
 * tool item. Mixed-name tool blocks pass through as a single tool item with
 * `name = ""` (caller falls back to per-call labels). Reasoning or text
 * between tool blocks always breaks the fold.
 */
function foldBlocks(blocks: ReadonlyArray<ContentBlock>): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.length > 0) items.push({ kind: "text", text: block.text });
      continue;
    }
    if (block.type === "reasoning") {
      if (block.text.length > 0) items.push({ kind: "reasoning", text: block.text });
      continue;
    }
    // tool block
    if (block.toolCalls.length === 0) continue;
    const sharedName = sameNameAcross(block.toolCalls);
    const prev = items[items.length - 1];
    if (
      sharedName !== null &&
      prev?.kind === "tool" &&
      prev.name === sharedName &&
      prev.name !== ""
    ) {
      prev.calls.push(...block.toolCalls);
    } else {
      items.push({
        kind: "tool",
        name: sharedName ?? "",
        calls: [...block.toolCalls],
      });
    }
  }
  return items;
}

function sameNameAcross(calls: ReadonlyArray<ToolCallDisplay>): string | null {
  if (calls.length === 0) return null;
  const first = calls[0].name;
  for (const c of calls) if (c.name !== first) return null;
  return first;
}

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
        // Reasoning / text are "active" only when they're the tail of a
        // currently-streaming message receiving deltas. Tool chips derive
        // their active state from per-call status (see ToolChip).
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
        if (item.kind === "reasoning") {
          return (
            <ReasoningChip
              // biome-ignore lint/suspicious/noArrayIndexKey: same as above
              key={`reasoning:${idx}`}
              text={item.text}
              isActive={isTailDelta}
              displayDetail={displayDetail}
            />
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: same as above
          <div key={`tool:${idx}`} className="flex flex-col gap-3">
            <ToolChip calls={item.calls} groupName={item.name} displayDetail={displayDetail} />
            <ToolWidgets calls={item.calls} />
          </div>
        );
      })}
      {isCurrentMessage && (
        <LiveCursor streamingState={streamingState} preparingTool={preparingTool} />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Live cursor — covers the gaps between blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render only when the engine is mid-flight but no block is absorbing the
 * state. The engine's streamingState tells us which case we're in:
 *
 *   - `streaming` → a text/reasoning block is receiving deltas; that block's
 *     own active state covers it → cursor hides.
 *   - `working`   → a tool call has status="running"; the ToolChip spins →
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
// Reasoning chip
// ─────────────────────────────────────────────────────────────────────────────

function ReasoningChip({
  text,
  isActive,
  displayDetail,
}: {
  text: string;
  isActive: boolean;
  displayDetail: DisplayDetail;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  if (displayDetail === "quiet") return null;

  const tone: ChipTone = isActive ? "running" : "ok";
  const tokenLabel = approximateTokenLabel(text.length);
  const head = isActive ? "Thinking…" : "Thought";

  return (
    <div className="turn-pill" data-tone={tone} data-expanded={open}>
      <button
        type="button"
        onClick={toggle}
        className="turn-pill__head"
        aria-expanded={open}
        disabled={text.length === 0}
      >
        <HeadIcon tone={tone} />
        <span className="turn-pill__label">{head}</span>
        {!isActive && tokenLabel && <span className="turn-pill__ms">· {tokenLabel}</span>}
        {text.length > 0 && (
          <ChevronRight className="turn-pill__chev" style={{ width: 14, height: 14 }} />
        )}
      </button>
      {open && text.length > 0 && (
        <div className="turn-pill__body">
          <div className="turn-pill__row-body">
            <pre className="turn-pill__reasoning">{text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool chip — one call OR a folded group of consecutive same-name calls
// ─────────────────────────────────────────────────────────────────────────────

function ToolChip({
  calls,
  groupName,
  displayDetail,
}: {
  calls: ReadonlyArray<ToolCallDisplay>;
  /** Shared name across folded calls; "" when calls have mixed names. */
  groupName: string;
  displayDetail: DisplayDetail;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  // Hold each call in "running" for at least the grace period so fast tools
  // don't flash. Smoothed statuses are overlaid back onto the descriptions
  // before tone / label derivation.
  const callsMutable = useMemo(() => [...calls], [calls]);
  const visualStatuses = useMinDisplayTime(callsMutable);
  const smoothed = useMemo(
    () => applyVisualStatuses(callsMutable, visualStatuses),
    [callsMutable, visualStatuses],
  );
  const descriptions = useMemo(() => smoothed.map(describeCall), [smoothed]);

  if (displayDetail === "quiet") return null;

  const tone: ChipTone = descriptions.some((d) => d.tone === "running")
    ? "running"
    : descriptions.some((d) => d.tone === "error")
      ? "error"
      : "ok";
  const totalMs = sumDurations(descriptions);
  const headLabel = chipHeadLabel(descriptions, tone, groupName);
  const subject = firstSubject(descriptions);
  const count = descriptions.length;

  return (
    <div className="turn-pill" data-tone={tone} data-expanded={open}>
      <button type="button" onClick={toggle} className="turn-pill__head" aria-expanded={open}>
        <HeadIcon tone={tone} />
        <span className="turn-pill__label">{headLabel}</span>
        {subject && <span className="turn-pill__row-subject">· {subject}</span>}
        {count > 1 && <span className="turn-pill__row-count">×{count}</span>}
        {tone !== "running" && totalMs != null && (
          <span className="turn-pill__ms">· {formatDuration(totalMs)}</span>
        )}
        <ChevronRight className="turn-pill__chev" style={{ width: 14, height: 14 }} />
      </button>
      {open && (
        <div className="turn-pill__body">
          <div className="turn-pill__row-body">
            {count === 1 ? (
              <ToolCallDetail item={descriptions[0]} />
            ) : (
              descriptions.map((d) => <ToolCallRow key={d.id} item={d} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline app views + resource-link cards a tool returned. Rendered below the
 * tool chip so the rich result presentation sits next to the work that
 * produced it.
 *
 * Filter rules match the prior MessageList behavior: `resourceUri` widgets
 * only render when the call is `done` AND the result came from a known
 * `appName` (so we know how to mount the bundle's UI).
 */
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

function chipHeadLabel(
  descriptions: ReadonlyArray<ToolDescription>,
  tone: ChipTone,
  groupName: string,
): string {
  if (descriptions.length === 0) return "Tool";
  // Mixed-name folded group: fall back to generic phrasing rather than
  // misrepresent which tool was used.
  if (groupName === "" && descriptions.length > 1) {
    return tone === "running" ? "Working…" : "Used tools";
  }
  const sample = descriptions[0];
  const verb = tone === "running" ? (PRESENT_TENSE[sample.verb] ?? sample.verb) : sample.verb;
  return sample.object ? `${verb} ${sample.object}` : verb;
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
// Shared chrome
// ─────────────────────────────────────────────────────────────────────────────

type ChipTone = Tone;

function HeadIcon({ tone }: { tone: ChipTone }) {
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

function firstSubject(items: ReadonlyArray<ToolDescription>): string | null {
  for (const it of items) {
    if (it.headSubject) return it.headSubject;
  }
  return null;
}

/** Same heuristic as the old reasoning row — 4 chars/token, k-form ≥2500. */
function approximateTokenLabel(charCount: number): string {
  if (charCount === 0) return "";
  const tokens = Math.round(charCount / 4);
  if (tokens >= 2500) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}
