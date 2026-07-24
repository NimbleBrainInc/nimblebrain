import { useCallback, useEffect, useMemo, useState } from "react";
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
 * text of each part." The budget bar (recorded latest turn) frames the whole
 * window; the layer list drills the live composition; the reading pane shows a
 * layer's composed body verbatim. Both reads are pure views over telemetry the
 * runtime already records — `compose__assembled_context` (the budget + skills
 * digest) and `compose__effective_context` (the composition, layer by layer,
 * with bodies).
 */
export function ContextInspectorPage() {
  const { slug, convId } = useParams<{ slug: string; convId: string }>();

  const [digest, setDigest] = useState<ComposeAssembledContextOutput | null>(null);
  const [composition, setComposition] = useState<ComposeEffectiveContextOutput | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [compositionError, setCompositionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
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

  // Select the first visible layer once the composition arrives, so the
  // reading pane is never empty when there's something to read.
  const visibleLayers = useMemo(
    () => (composition ? filterLayers(composition.layers, bucket) : []),
    [composition, bucket],
  );
  useEffect(() => {
    if (visibleLayers.length === 0) {
      setSelectedLayer(null);
      return;
    }
    if (!visibleLayers.some((l) => layerKey(l) === selectedLayer)) {
      setSelectedLayer(layerKey(visibleLayers[0]));
    }
  }, [visibleLayers, selectedLayer]);

  const selected = visibleLayers.find((l) => layerKey(l) === selectedLayer) ?? null;

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
        <>
          <BudgetBar
            sources={digest.sources}
            totalTokens={digest.totalTokens}
            active={bucket}
            onSelect={setBucket}
          />
          <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,44%)_minmax(0,1fr)]">
            <LayerListPane
              layers={visibleLayers}
              bucket={bucket}
              selected={selectedLayer}
              onSelect={setSelectedLayer}
              loading={loading && !composition}
              error={compositionError}
            />
            <ReadingPane layer={selected} warnings={composition?.warnings ?? []} />
          </div>
        </>
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
    <div className="shrink-0 px-6 py-4 border-b border-border" data-testid="context-budget">
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

// ── layer list ───────────────────────────────────────────────────────────

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

function LayerListPane({
  layers,
  bucket,
  selected,
  onSelect,
  loading,
  error,
}: {
  layers: TracedLayerView[];
  bucket: string | null;
  selected: string | null;
  onSelect: (key: string) => void;
  loading: boolean;
  error: string | null;
}) {
  const max = Math.max(...layers.map((l) => l.tokens), 1);
  return (
    <div className="border-r border-border flex flex-col min-h-0" data-testid="context-layers">
      <div className="shrink-0 px-5 pt-3 pb-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
        Composition
        <span className="font-normal normal-case tracking-normal text-2xs text-muted-foreground/60">
          {" "}
          · what would load now
        </span>
      </div>
      <div className="overflow-y-auto flex-1">
        {loading && <div className="px-5 py-3 text-xs text-muted-foreground">Composing…</div>}
        {error && <div className="px-5 py-3 text-xs text-destructive">{error}</div>}
        {!loading && !error && layers.length === 0 && (
          <div className="px-5 py-3 text-xs text-muted-foreground">
            {bucket === "skills"
              ? "No matched skills entered this turn's prompt. The budget above still counts everything that loaded."
              : "Nothing composes for this conversation right now."}
          </div>
        )}
        {layers.map((l) => {
          const isSel = layerKey(l) === selected;
          return (
            <button
              key={layerKey(l)}
              type="button"
              onClick={() => onSelect(layerKey(l))}
              className={`w-full text-left px-5 py-2.5 space-y-1 transition-colors ${
                isSel ? "bg-warm/10 shadow-[inset_3px_0_0_var(--warm)]" : "hover:bg-muted"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium flex-1 min-w-0 truncate">
                  {layerTitle(l)}
                  {l.segment === "volatile" && (
                    <span className="text-3xs text-muted-foreground/60"> · per-turn</span>
                  )}
                </span>
                <span className="text-3xs text-muted-foreground tabular-nums shrink-0">
                  {formatTokenCount(l.tokens)} tok
                </span>
              </div>
              <span className="block h-1 rounded-full bg-muted overflow-hidden">
                <span
                  className="block h-full rounded-full bg-muted-foreground/80"
                  style={{ width: `${Math.round((l.tokens / max) * 100)}%` }}
                />
              </span>
              {layerDescriptor(l) && (
                <div className="text-3xs text-muted-foreground/80 truncate" title={l.source}>
                  {layerDescriptor(l)}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── reading pane ───────────────────────────────────────────────────────────

function ReadingPane({ layer, warnings }: { layer: TracedLayerView | null; warnings: string[] }) {
  if (!layer) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-muted-foreground/60 bg-muted/50">
        Select a layer to read its composed body.
      </div>
    );
  }
  // A section that aggregates several skills (layer-3) carries each skill's own
  // body on its sub-items — render them individually rather than as one wall.
  const itemized = (layer.subItems ?? []).filter(
    (s): s is typeof s & { text: string } => typeof s.text === "string" && s.text.length > 0,
  );
  return (
    <div className="flex flex-col min-h-0 bg-muted/50" data-testid="context-reading-pane">
      <div className="shrink-0 px-6 pt-4 pb-3 border-b border-border">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h2 className="text-base font-semibold">{layerTitle(layer)}</h2>
          {layer.segment === "volatile" && (
            <span className="text-3xs rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
              per-turn
            </span>
          )}
          <span className="text-2xs text-muted-foreground tabular-nums ml-auto">
            {formatTokenCount(layer.tokens)} tok
          </span>
        </div>
        {layerDescriptor(layer) && (
          <div className="mt-1 text-2xs text-muted-foreground" title={layer.source}>
            {layerDescriptor(layer)}
          </div>
        )}
        {itemized.length === 0 && layer.subItems && layer.subItems.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {layer.subItems.map((sub) => (
              <span
                key={sub.id}
                className="text-3xs rounded px-1.5 py-0.5 bg-muted text-muted-foreground"
                title={sub.source}
              >
                {skillName(sub.id)}
              </span>
            ))}
          </div>
        )}
        {itemized.length > 0 && (
          <div className="mt-1 text-2xs text-muted-foreground">
            {itemized.length} skill{itemized.length === 1 ? "" : "s"}, each shown with its own body
          </div>
        )}
      </div>
      <div className="overflow-y-auto flex-1 p-6 space-y-4">
        {itemized.length > 0 ? (
          itemized.map((sub) => (
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
              <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono text-foreground bg-card border border-border rounded-lg p-4 m-0">
                {sub.text}
              </pre>
            </div>
          ))
        ) : (
          <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono text-foreground bg-card border border-border rounded-lg p-4 m-0">
            {layer.text}
          </pre>
        )}
        {warnings.length > 0 && (
          <div className="mt-3 text-3xs text-muted-foreground space-y-1">
            {warnings.map((w) => (
              <p key={w} className="m-0">
                {w}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
