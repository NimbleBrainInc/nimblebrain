import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
// Canonical shapes from `src/tools/platform/schemas/compose.ts`; mirrored
// here via codegen so server + web can't drift.
import type {
  AssembledContextSkill,
  AssembledContextSource,
  ComposeAssembledContextOutput,
  ComposeEffectiveContextOutput,
  TracedLayerView,
} from "../_generated/platform-schemas/compose";
import { callTool } from "../api/client";
import { SOURCE_LABEL, skillsSlice, sourceDetail, windowSources } from "../lib/context-sources";
import {
  formatTokenCount,
  groupByMechanism,
  nameFromSkillId,
  SCOPE_CLASS,
  skillProvenanceLabel,
} from "../lib/skill-display";
import { parseToolResponse } from "../lib/tool-response";

/**
 * Full-page context inspector — the room the In-context popover opens into.
 *
 * Answers "what is in this conversation's context window, and what is the exact
 * text of each part." A single scrolling column: the budget frames the whole
 * window, then each composition layer expands in place to reveal its composed
 * body verbatim. One scroll region, so it stays legible however narrow the
 * column gets beside the docked chat.
 *
 * Pure views over telemetry the runtime already records —
 * `compose__assembled_context` (the budget + skills digest) and
 * `compose__effective_context` (the composition, layer by layer, with bodies).
 */
export function ContextInspectorPage() {
  const { slug, convId } = useParams<{ slug: string; convId: string }>();

  const [digest, setDigest] = useState<ComposeAssembledContextOutput | null>(null);
  const [composition, setComposition] = useState<ComposeEffectiveContextOutput | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [compositionError, setCompositionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [bucket, setBucket] = useState<string | null>(null);

  // Re-armed by the load effect below on every :convId change, so the first
  // layer auto-expands for each conversation (the route element is reused).
  const openedInitial = useRef(false);

  // Load the budget + composition for the current conversation. The route
  // element is reused across a :convId change (the docked chat stays mounted),
  // so each change drops the prior conversation's data, expansion state, and
  // auto-open latch, and — via the cleanup flag — ignores that conversation's
  // reads still in flight. Otherwise a slow A read lands in B's view (B's id
  // over A's budget, A's composed body as B's). The two reads are independent,
  // so each renders as it resolves and one failing doesn't blank the other;
  // the empty/error branches gate on an absent digest, so clearing it also lets
  // a failed budget read surface rather than leaving stale numbers on screen.
  useEffect(() => {
    if (!convId) return;
    let cancelled = false;
    setLoading(true);
    setBudgetError(null);
    setCompositionError(null);
    setDigest(null);
    setComposition(null);
    setOpen(new Set());
    openedInitial.current = false;
    const budget = callTool("compose", "assembled_context", { conversation_id: convId })
      .then((res) => {
        if (!cancelled) setDigest(parseToolResponse<ComposeAssembledContextOutput>(res));
      })
      .catch((err) => {
        if (!cancelled)
          setBudgetError(err instanceof Error ? err.message : "Failed to load the budget.");
      });
    const comp = callTool("compose", "effective_context", { conversation_id: convId })
      .then((res) => {
        if (!cancelled) setComposition(parseToolResponse<ComposeEffectiveContextOutput>(res));
      })
      .catch((err) => {
        if (!cancelled)
          setCompositionError(
            err instanceof Error ? err.message : "Failed to compose the context.",
          );
      });
    void Promise.allSettled([budget, comp]).then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [convId]);

  const visibleLayers = useMemo(
    () => (composition ? filterLayers(composition.layers, bucket) : []),
    [composition, bucket],
  );

  // Open the first layer once the composition arrives, so the reader lands on
  // something rather than an all-collapsed list. Toggles after that are the
  // user's. The latch is re-armed by the load effect above per conversation.
  useEffect(() => {
    if (!openedInitial.current && visibleLayers.length > 0) {
      openedInitial.current = true;
      setOpen(new Set([layerKey(visibleLayers[0])]));
    }
  }, [visibleLayers]);

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Selecting a budget bucket is a drill-in, so reveal it: open the first layer
  // that becomes visible under the filter (added, not replacing, so the reader's
  // other expansions survive). Clearing the filter forces nothing open.
  const selectBucket = useCallback(
    (next: string | null) => {
      setBucket(next);
      if (next && composition) {
        const visible = filterLayers(composition.layers, next);
        if (visible.length > 0) {
          const first = layerKey(visible[0]);
          setOpen((prev) => new Set(prev).add(first));
        }
      }
    },
    [composition],
  );

  const navigate = useNavigate();
  // Return to wherever the inspector was opened from (an app, the conversations
  // list, the overview), not a fixed destination. React Router stamps an
  // incrementing `idx` on history state; a direct load / refresh / shared link
  // has idx 0, so fall back to the workspace overview rather than leaving the app.
  const goBack = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(slug ? `/w/${slug}/` : "/");
  }, [navigate, slug]);

  return (
    <div className="h-full flex flex-col overflow-hidden" data-testid="context-inspector-page">
      <header className="shrink-0 px-6 pt-5 pb-4 border-b border-border">
        <div className="text-2xs text-muted-foreground mb-1.5 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">
            <button type="button" onClick={goBack} className="hover:text-foreground">
              ← Back
            </button>
            <span className="mx-1.5 text-muted-foreground">·</span>
            <span className="font-mono">{convId}</span>
          </span>
          {slug && (
            <Link to={`/w/${slug}/settings/skills`} className="shrink-0 hover:text-foreground">
              Manage skills ↗
            </Link>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-heading font-medium text-foreground">Assembled context</h1>
          {digest && digest.runId !== null && (
            <div className="text-xs text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">
                {formatTokenCount(digest.windowTokens)}
              </span>{" "}
              tokens in the window · latest turn
            </div>
          )}
        </div>
      </header>

      {loading && !digest && (
        <div className="p-8 text-sm text-muted-foreground">Loading context…</div>
      )}

      {!loading && budgetError && !digest && (
        <div className="p-8 text-sm text-destructive" data-testid="context-inspector-error">
          {budgetError}
        </div>
      )}

      {digest && digest.runId === null && (
        <div className="p-8 text-sm text-muted-foreground">
          No context recorded yet. Send a message in this conversation to populate it.
        </div>
      )}

      {digest && digest.runId !== null && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <BudgetBar
            sources={digest.sources}
            windowTokens={digest.windowTokens}
            active={bucket}
            onSelect={selectBucket}
          />
          {/* The Skills card counts a recorded turn, so its drill-down reads the
              same recording. The composition below can't answer for it: it
              recomposes CURRENT state, which holds no trigger match (that needs
              the user's message) and no record of what loaded then. */}
          {bucket === "skills" && <RecordedSkills skills={digest.skills} />}
          <LayerAccordion
            layers={visibleLayers}
            open={open}
            onToggle={toggle}
            emptyMessage={
              bucket === "skills"
                ? // Answered above, from the recording. A second "nothing here"
                  // under it would read as a contradiction of the card's number.
                  null
                : "Nothing composes for this conversation right now."
            }
            loading={loading && !composition}
            error={compositionError}
            warnings={composition?.warnings ?? []}
          />
        </div>
      )}
    </div>
  );
}

// ── budget bar ─────────────────────────────────────────────────────────────

/** Budget buckets that map onto composed layers (the drill is meaningful). */
const DRILLABLE = new Set(["system_prompt", "skills"]);

/**
 * What occupies the context window this turn.
 *
 * ONE bar, because the window is one quantity and these are its parts. Each
 * region is a segment sized by its share; the `skills` annotation is a band
 * inside the system-prompt segment, since that is literally where those tokens
 * are. Which rows are regions is the server's call, read off the `annotation`
 * stamp via `windowSources` / `skillsSlice`, never a second copy of that list
 * here.
 *
 * This replaced a row of cards, and each thing it fixes was a symptom of that
 * idiom:
 *
 *   - A card is an actionable object, so three identical cards promised three
 *     drill-downs and honoured one. Interactivity is now carried by the element
 *     itself — a legend entry that drills is a `button`, one that can't is
 *     text — so the affordance can't over-promise.
 *   - The card holding the nested annotation was taller than its neighbours.
 *     One bar has one height.
 *   - Three boxes of border, padding, and their own bars cost most of a phone
 *     screen before the composition started. A bar and a wrapping legend cost a
 *     fraction of it, and reflow instead of squeezing three columns.
 *
 * A segment's share is of the WINDOW, not the recorded `totalTokens` — that sum
 * counts the skill bodies twice (they are composed into the system prompt), so
 * scaling to it shrinks every segment by the size of the overlap.
 */
function BudgetBar({
  sources,
  windowTokens,
  active,
  onSelect,
}: {
  sources: AssembledContextSource[];
  windowTokens: number;
  active: string | null;
  onSelect: (bucket: string | null) => void;
}) {
  const regions = windowSources(sources);
  const skills = skillsSlice(sources);
  const max = Math.max(windowTokens, 1);
  const share = (tokens: number, of = max) => `${Math.min((tokens / Math.max(of, 1)) * 100, 100)}%`;
  const select = (kind: string) => () => onSelect(active === kind ? null : kind);
  return (
    <div
      className="sticky top-0 z-10 bg-background px-6 py-3.5 border-b border-border"
      data-testid="context-budget"
    >
      <div className="flex h-2 w-full gap-px rounded-full overflow-hidden bg-muted">
        {regions.map((s) => (
          <div
            key={s.kind}
            // `min-w-px` so a region that rounds to nothing (a one-message
            // history against a full window) still reads as present.
            className={`relative min-w-px ${SEGMENT_TONE[s.kind] ?? "bg-muted-foreground/30"} ${
              active === s.kind ? "bg-primary" : ""
            }`}
            style={{ width: share(s.tokens) }}
          >
            {s.kind === "system_prompt" && skills && (
              // Drawn INSIDE its region: the annotation is a part of that
              // segment, not a fourth one competing with it for the bar.
              <span
                className={`absolute left-0 bottom-0 h-1/2 ${
                  active === "skills" ? "bg-primary" : "bg-background/55"
                }`}
                style={{ width: share(skills.tokens, s.tokens) }}
              />
            )}
          </div>
        ))}
      </div>
      {/* Wraps rather than columns, so a narrow column reflows the legend
          instead of crushing every entry. */}
      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {regions.map((s) => (
          // The region and its annotation travel as one flex item, so a wrap
          // never strands "of which skills" under a different region.
          <div key={s.kind} className="flex items-baseline gap-x-2 min-w-0">
            <LegendEntry
              source={s}
              tone={SEGMENT_TONE[s.kind] ?? "bg-muted-foreground/30"}
              active={active === s.kind}
              onSelect={DRILLABLE.has(s.kind) ? select(s.kind) : null}
            />
            {s.kind === "system_prompt" && skills && (
              <LegendEntry
                source={skills}
                label="of which skills"
                tone="bg-muted-foreground/25"
                active={active === "skills"}
                onSelect={select("skills")}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Segment shading, so adjacent parts of one bar stay tellable apart. Local to
 * this bar: it is the only surface that draws the regions as a single stacked
 * quantity — the popover lists them as separate rows and needs no such scale.
 * Keyed with a fallback, so a region kind added server-side still renders.
 */
const SEGMENT_TONE: Record<string, string> = {
  system_prompt: "bg-muted-foreground/70",
  tool_descriptions: "bg-muted-foreground/45",
  history: "bg-muted-foreground/30",
};

/**
 * One legend entry: swatch, label, tokens, and any count detail.
 *
 * A `null` onSelect renders plain text, NOT a disabled-looking control — the
 * region is real and its number is real, there is simply nothing composed to
 * drill into (the page shows no tool descriptions and no history). Rendering it
 * as a button that does nothing, or as a card identical to one that works, is
 * the promise this shape exists to stop making.
 */
function LegendEntry({
  source,
  label,
  tone,
  active,
  onSelect,
}: {
  source: AssembledContextSource;
  label?: string;
  tone: string;
  active: boolean;
  onSelect: (() => void) | null;
}) {
  const detail = sourceDetail(source);
  // Name (with its count) then value, in that order and with the count bound to
  // the name by a separator. Trailing it after the tokens read as a second,
  // unlabelled quantity — "Tools 4.8k 32" doesn't say which number is tokens.
  const body = (
    <>
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${active ? "bg-primary" : tone}`} />
      <span className={`text-2xs truncate ${active ? "text-primary" : "text-muted-foreground"}`}>
        {label ?? SOURCE_LABEL[source.kind] ?? source.kind}
        {detail && <span className="text-muted-foreground"> · {detail}</span>}
      </span>
      <span className="ml-0.5 text-2xs font-medium text-foreground tabular-nums shrink-0">
        {formatTokenCount(source.tokens)}
      </span>
    </>
  );
  if (!onSelect) {
    return (
      <span
        className="flex items-baseline gap-1.5 min-w-0"
        title="Not composed into the prompt — token cost only"
      >
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      title="Show what this is made of"
      className={`flex items-baseline gap-1.5 min-w-0 -mx-1 px-1 rounded cursor-pointer transition-colors ${
        active ? "bg-primary/10" : "hover:bg-muted"
      }`}
    >
      {body}
    </button>
  );
}

// ── recorded skills (the Skills card's drill-down) ──────────────────────────

/**
 * The skills the recorded turn loaded, grouped by why — the drill-down for the
 * Skills budget card, projected from the same `skills.loaded` event that
 * produced its token count. So the list can never disagree with the number
 * above it.
 *
 * This is deliberately NOT the composition below. That is a live recomposition
 * of current state: it holds only what tool-affinity selects right now, never
 * the turn's trigger match (which needs the user's message) and never the
 * always-on skills, which compose into their own layers rather than the
 * layer-3 section. Filtering it by the layer-3 section left every other
 * mechanism — most of what a turn typically loads — with nowhere to appear.
 *
 * Grouping, scope colors, and provenance come from the shared helpers, so this
 * reads identically to the In-context popover the page opens from. Bodies live
 * on the composition's layers, not here: the recording carries token counts and
 * provenance, not text.
 */
function RecordedSkills({ skills }: { skills: AssembledContextSkill[] }) {
  return (
    <div className="border-b border-border" data-testid="recorded-skills">
      <div className="px-6 pt-3 pb-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        Loaded
        <span className="font-normal normal-case tracking-normal text-2xs">
          {" "}
          · what the recorded turn composed
        </span>
      </div>
      {skills.length === 0 ? (
        <div className="px-6 py-3 text-xs text-muted-foreground">
          No skills loaded for this turn.
        </div>
      ) : (
        groupByMechanism(skills).map((group) => (
          <div key={group.mechanism} className="px-6 pb-1.5">
            <p className="pt-1.5 pb-0.5 m-0 text-2xs text-muted-foreground">{group.label}</p>
            <ul className="m-0 p-0 list-none">
              {group.skills.map((s) => (
                <li key={s.id} className="ledger-line__row" title={s.reason}>
                  <span className="disclosure__dot" aria-hidden />
                  <span className="ledger-line__row-name">{s.name}</span>
                  <span className={`ledger-line__scope ${SCOPE_CLASS[s.scope]}`}>
                    {skillProvenanceLabel(s)}
                  </span>
                  <span className="ledger-line__row-tok">{formatTokenCount(s.tokens)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

// ── layers (drill-in-place) ────────────────────────────────────────────────

const LAYER_LABEL: Record<string, string> = {
  default_identity: "Identity (default)",
  task_identity: "Identity (task)",
  core_skill: "Core skill",
  user_context_skill: "User context skill",
  user_prefs: "User preferences",
  current_date: "Current date",
  workspace_context: "Workspace",
  org_overlay: "Org instructions",
  workspace_overlay: "Workspace instructions",
  layer3_skills: "Layer-3 skills",
  apps: "Apps",
  app_state: "App state",
  focused_app: "Focused app",
  matched_skill: "Matched skill",
};

function layerKey(l: TracedLayerView): string {
  return `${l.kind}:${l.id}`;
}

/** File-backed layers are specific skills/overlays; `nb:`-prefixed layers are structural. */
function isNamedFile(l: TracedLayerView): boolean {
  return l.id.includes("/");
}

/** Primary label: a file-backed layer is named by its skill; a structural one by its kind. */
function layerTitle(l: TracedLayerView): string {
  // `TracedLayerView` carries no name, so a file-backed layer is named from its
  // id — through the shared helper, never a local copy of the rule.
  return isNamedFile(l) ? nameFromSkillId(l.id) : (LAYER_LABEL[l.kind] ?? l.kind);
}

/** Muted descriptor under a named skill (its kind); empty for structural layers. */
function layerDescriptor(l: TracedLayerView): string {
  return isNamedFile(l) ? (LAYER_LABEL[l.kind] ?? l.kind) : "";
}

/**
 * A budget bucket selects the layers composed under it. Only `system_prompt`
 * and `skills` are drillable (tools/history aren't composed into the prompt —
 * their segments are disabled), so `bucket` is only ever null or one of those.
 *
 * Under `skills` this narrows the live composition to the layer-3 section,
 * which sits below `RecordedSkills` as the composed *text* of the skills that
 * still load. The recorded list above it is what answers for the card's number;
 * this can legitimately be empty while that one isn't.
 */
function filterLayers(layers: TracedLayerView[], bucket: string | null): TracedLayerView[] {
  if (bucket === "skills") return layers.filter((l) => l.kind === "layer3_skills");
  if (bucket === "system_prompt") return layers.filter((l) => l.kind !== "layer3_skills");
  return layers;
}

function LayerAccordion({
  layers,
  open,
  onToggle,
  emptyMessage,
  loading,
  error,
  warnings,
}: {
  layers: TracedLayerView[];
  open: Set<string>;
  onToggle: (key: string) => void;
  /** Shown when nothing composes; `null` when the caller answers that itself. */
  emptyMessage: string | null;
  loading: boolean;
  error: string | null;
  warnings: string[];
}) {
  const max = Math.max(...layers.map((l) => l.tokens), 1);
  return (
    <div>
      <div className="px-6 pt-3 pb-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        Composition
        <span className="font-normal normal-case tracking-normal text-2xs">
          {" "}
          · what would load now
        </span>
      </div>
      {loading && <div className="px-6 py-3 text-xs text-muted-foreground">Composing…</div>}
      {error && <div className="px-6 py-3 text-xs text-destructive">{error}</div>}
      {!loading && !error && layers.length === 0 && emptyMessage !== null && (
        <div className="px-6 py-3 text-xs text-muted-foreground">{emptyMessage}</div>
      )}
      {layers.map((l) => (
        <AccordionRow
          key={layerKey(l)}
          layer={l}
          open={open.has(layerKey(l))}
          onToggle={() => onToggle(layerKey(l))}
          max={max}
        />
      ))}
      {warnings.length > 0 && layers.length > 0 && (
        <div className="px-6 py-4 text-3xs text-muted-foreground space-y-1 border-t border-border">
          {warnings.map((w) => (
            <p key={w} className="m-0">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function AccordionRow({
  layer,
  open,
  onToggle,
  max,
}: {
  layer: TracedLayerView;
  open: boolean;
  onToggle: () => void;
  max: number;
}) {
  const bodyId = useId();
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className={`w-full text-left px-6 py-3 space-y-1.5 transition-colors ${
          open ? "bg-primary/5" : "hover:bg-muted/60"
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-muted-foreground shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          >
            ▸
          </span>
          <span className="text-sm font-medium flex-1 min-w-0 truncate" title={layer.source}>
            {layerTitle(layer)}
            {layer.segment === "volatile" && (
              <span className="text-3xs text-muted-foreground"> · per-turn</span>
            )}
          </span>
          <span className="text-3xs text-muted-foreground tabular-nums shrink-0">
            {formatTokenCount(layer.tokens)} tok
          </span>
        </div>
        <div className="pl-5 flex items-center gap-2">
          <span className="block h-1 flex-1 rounded-full bg-muted overflow-hidden">
            <span
              className="block h-full rounded-full bg-muted-foreground/80"
              style={{ width: `${Math.round((layer.tokens / max) * 100)}%` }}
            />
          </span>
          {layerDescriptor(layer) && (
            <span className="text-3xs text-muted-foreground shrink-0">
              {layerDescriptor(layer)}
            </span>
          )}
        </div>
      </button>
      {open && (
        <div id={bodyId} className="px-6 pt-3 pb-5 pl-11">
          <LayerBody layer={layer} />
        </div>
      )}
    </div>
  );
}

/** The layer's composed body, verbatim — the exact text that entered the window
 *  (section header, each skill's provenance line, the containment wrapper, and
 *  the bodies), so the inspector shows the truth the runtime composed rather than
 *  a re-derived copy of it. */
function LayerBody({ layer }: { layer: TracedLayerView }) {
  return (
    <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono text-foreground bg-muted/40 border border-border rounded-lg p-4 m-0">
      {layer.text}
    </pre>
  );
}
