import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
// Canonical shapes from `src/tools/platform/schemas/compose.ts`; mirrored
// here via codegen so server + web can't drift.
import type {
  AssembledContextSource,
  ComposeAssembledContextOutput,
  ComposeEffectiveContextOutput,
  TracedLayerView,
} from "../_generated/platform-schemas/compose";
import { callTool } from "../api/client";
import { orderedSources, SOURCE_LABEL, sourceDetail } from "../lib/context-sources";
import { formatTokenCount } from "../lib/skill-display";
import { parseToolResponse } from "../lib/tool-response";

/**
 * Full-page context inspector — the room the In-context popover opens into.
 *
 * Answers "what is in this conversation's context window, and what is the exact
 * text of each part." A single scrolling column: the budget frames the whole
 * window, then each composition layer expands in place to reveal its composed
 * body (a skills layer expands into its individual skills). One scroll region,
 * so it stays legible however narrow the column gets beside the docked chat.
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

  const load = useCallback(async () => {
    if (!convId) return;
    setLoading(true);
    setBudgetError(null);
    setCompositionError(null);
    // Independent reads: the budget (small, recorded) and the composition
    // (larger, recomposed) render as each resolves; one failing doesn't blank
    // the other.
    const budget = callTool("compose", "assembled_context", { conversation_id: convId })
      .then((res) => setDigest(parseToolResponse<ComposeAssembledContextOutput>(res)))
      .catch((err) =>
        setBudgetError(err instanceof Error ? err.message : "Failed to load the budget."),
      );
    const comp = callTool("compose", "effective_context", { conversation_id: convId })
      .then((res) => setComposition(parseToolResponse<ComposeEffectiveContextOutput>(res)))
      .catch((err) =>
        setCompositionError(err instanceof Error ? err.message : "Failed to compose the context."),
      );
    await Promise.allSettled([budget, comp]);
    setLoading(false);
  }, [convId]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleLayers = useMemo(
    () => (composition ? filterLayers(composition.layers, bucket) : []),
    [composition, bucket],
  );

  // Open the first layer once the composition arrives, so the reader lands on
  // something rather than an all-collapsed list. Toggles after that are the
  // user's; a re-filter doesn't force anything back open.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (!openedInitial.current && visibleLayers.length > 0) {
      openedInitial.current = true;
      setOpen(new Set([layerKey(visibleLayers[0])]));
    }
  }, [visibleLayers]);

  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

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
            <span className="mx-1.5 text-muted-foreground/60">·</span>
            <span className="font-mono">{convId}</span>
          </span>
          {slug && (
            <Link to={`/w/${slug}/settings/skills`} className="shrink-0 hover:text-foreground">
              Manage skills ↗
            </Link>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-serif font-medium text-foreground">Assembled context</h1>
          {digest && digest.runId !== null && (
            <div className="text-xs text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">
                {formatTokenCount(digest.totalTokens)}
              </span>{" "}
              tokens · latest turn
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
        <div className="flex-1 min-h-0 overflow-y-auto" data-testid="context-layers">
          <BudgetBar
            sources={digest.sources}
            totalTokens={digest.totalTokens}
            active={bucket}
            onSelect={setBucket}
          />
          <LayerAccordion
            layers={visibleLayers}
            open={open}
            onToggle={toggle}
            bucket={bucket}
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

function BudgetBar({
  sources,
  totalTokens,
  active,
  onSelect,
}: {
  sources: AssembledContextSource[];
  totalTokens: number;
  active: string | null;
  onSelect: (bucket: string | null) => void;
}) {
  const ordered = orderedSources(sources);
  const max = Math.max(totalTokens, 1);
  return (
    <div className="px-6 py-4 border-b border-border" data-testid="context-budget">
      {/* Equal-width cards: the token size drives the inner bar, never the card
          width, so a small bucket (history) stays readable next to a large one
          (tools) at any container width. */}
      <div className="grid grid-cols-4 gap-2">
        {ordered.map((s) => {
          const selectable = DRILLABLE.has(s.kind);
          const isActive = active === s.kind;
          const pct = Math.round((s.tokens / max) * 100);
          const content = (
            <>
              <div className="flex items-baseline justify-between gap-1.5">
                <span className="text-2xs font-medium text-foreground truncate">
                  {SOURCE_LABEL[s.kind] ?? s.kind}
                </span>
                {sourceDetail(s) && (
                  <span className="text-3xs text-muted-foreground tabular-nums shrink-0">
                    {sourceDetail(s)}
                  </span>
                )}
              </div>
              <div className="mt-1 text-sm font-semibold text-foreground tabular-nums">
                {formatTokenCount(s.tokens)}
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${isActive ? "bg-warm" : "bg-muted-foreground/80"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </>
          );
          const base = "block rounded-md border px-3 py-2.5 text-left min-w-0";
          if (!selectable) {
            return (
              <div
                key={s.kind}
                className={`${base} border-border bg-card`}
                title="Not composed into the prompt — token cost only"
              >
                {content}
              </div>
            );
          }
          return (
            <button
              key={s.kind}
              type="button"
              onClick={() => onSelect(isActive ? null : s.kind)}
              title="Filter the layers below"
              className={`${base} cursor-pointer transition-colors ${
                isActive ? "border-warm bg-warm/10" : "border-border bg-card hover:bg-muted/60"
              }`}
            >
              {content}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-3xs text-muted-foreground">
        <span>
          {active
            ? `Filtered to ${SOURCE_LABEL[active] ?? active} · click again to clear`
            : "Click System prompt or Skills to filter the layers"}
        </span>
        <span className="tabular-nums">
          Total <span className="font-medium text-foreground">{formatTokenCount(totalTokens)}</span>{" "}
          tok
        </span>
      </div>
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

/** A skill/overlay name from its file id — handles `<name>.md` and `<name>/SKILL.md`. */
function skillName(id: string): string {
  const parts = id.split("/").filter(Boolean);
  let name = parts[parts.length - 1] ?? id;
  if (/^SKILL\.md$/i.test(name) && parts.length >= 2) name = parts[parts.length - 2];
  return name.replace(/\.md$/i, "");
}

/** Primary label: a file-backed layer is named by its skill; a structural one by its kind. */
function layerTitle(l: TracedLayerView): string {
  return isNamedFile(l) ? skillName(l.id) : (LAYER_LABEL[l.kind] ?? l.kind);
}

/** Muted descriptor under a named skill (its kind); empty for structural layers. */
function layerDescriptor(l: TracedLayerView): string {
  return isNamedFile(l) ? (LAYER_LABEL[l.kind] ?? l.kind) : "";
}

/**
 * A budget bucket selects the layers composed under it. Only `system_prompt`
 * and `skills` are drillable (tools/history aren't composed into the prompt —
 * their segments are disabled), so `bucket` is only ever null or one of those.
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
  bucket,
  loading,
  error,
  warnings,
}: {
  layers: TracedLayerView[];
  open: Set<string>;
  onToggle: (key: string) => void;
  bucket: string | null;
  loading: boolean;
  error: string | null;
  warnings: string[];
}) {
  const max = Math.max(...layers.map((l) => l.tokens), 1);
  return (
    <div>
      <div className="px-6 pt-3 pb-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        Composition
        <span className="font-normal normal-case tracking-normal text-2xs text-muted-foreground/60">
          {" "}
          · what would load now
        </span>
      </div>
      {loading && <div className="px-6 py-3 text-xs text-muted-foreground">Composing…</div>}
      {error && <div className="px-6 py-3 text-xs text-destructive">{error}</div>}
      {!loading && !error && layers.length === 0 && (
        <div className="px-6 py-3 text-xs text-muted-foreground">
          {bucket === "skills"
            ? "No matched skills entered this turn's prompt. The budget above still counts everything that loaded."
            : "Nothing composes for this conversation right now."}
        </div>
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
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`w-full text-left px-6 py-3 space-y-1.5 transition-colors ${
          open ? "bg-warm/5" : "hover:bg-muted/60"
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
              <span className="text-3xs text-muted-foreground/60"> · per-turn</span>
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
            <span className="text-3xs text-muted-foreground/80 shrink-0">
              {layerDescriptor(layer)}
            </span>
          )}
        </div>
      </button>
      {open && (
        <div className="px-6 pb-5 pl-11">
          <LayerBody layer={layer} />
        </div>
      )}
    </div>
  );
}

/** The composed body of a layer. When the layer aggregates several skills, list
 *  each one with its own body rather than a single combined wall. */
function LayerBody({ layer }: { layer: TracedLayerView }) {
  const itemized = (layer.subItems ?? []).filter(
    (s): s is typeof s & { text: string } => typeof s.text === "string" && s.text.length > 0,
  );
  if (itemized.length > 0) {
    return (
      <div className="space-y-4">
        <div className="text-2xs text-muted-foreground">
          {itemized.length} skill{itemized.length === 1 ? "" : "s"}, each shown with its own body
        </div>
        {itemized.map((sub) => (
          <div key={sub.id}>
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className="text-sm font-medium truncate" title={sub.source}>
                {skillName(sub.id)}
              </span>
              {typeof sub.tokens === "number" && (
                <span className="text-3xs text-muted-foreground tabular-nums ml-auto shrink-0">
                  {formatTokenCount(sub.tokens)} tok
                </span>
              )}
            </div>
            <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono text-foreground bg-muted/40 border border-border rounded-lg p-4 m-0">
              {sub.text}
            </pre>
          </div>
        ))}
      </div>
    );
  }
  return (
    <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono text-foreground bg-muted/40 border border-border rounded-lg p-4 m-0">
      {layer.text}
    </pre>
  );
}
