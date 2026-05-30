import { Lightbulb, Plus, Trash2, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ToolInput } from "../../_generated/platform-schemas/catalog";
import { callTool } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { parseToolResponse } from "../../lib/tool-response";
import { cn } from "../../lib/utils";
import { RequireActiveWorkspace } from "./components/RequireActiveWorkspace";

// ── Types ────────────────────────────────────────────────────────────────
//
// Canonical shapes from `src/tools/platform/schemas/skills.ts`, mirrored
// here via codegen at `web/src/_generated/platform-schemas/`. Server and
// web both import from the same declarations so a shape change in one
// place can't silently drift from the other (the pattern §2.1 in
// `src/tools/platform/AGENTS.md` exists to enforce). Local aliases keep
// the diff small for historical readers.
import type {
  SkillDetail as ReadSkill,
  SkillScope as Scope,
  SkillsListOutput,
  SkillStatus as Status,
  SkillSummary as ListedSkill,
} from "../../_generated/platform-schemas/skills";

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const SCOPE_BADGE: Record<Scope, string> = {
  org: "border-blue-300/30 text-blue-400",
  workspace: "border-emerald-300/30 text-emerald-400",
  user: "border-violet-300/30 text-violet-400",
  bundle: "border-amber-300/30 text-amber-400",
};

const STATUS_BADGE: Record<Status, string> = {
  active: "border-emerald-300/30 text-emerald-500",
  draft: "border-amber-300/30 text-amber-500",
  disabled: "border-muted text-muted-foreground",
  archived: "border-muted text-muted-foreground",
};

// ── Component ────────────────────────────────────────────────────────────

export function SkillsTab() {
  return (
    <RequireActiveWorkspace>
      <SkillsBrowser surface="workspace" />
    </RequireActiveWorkspace>
  );
}

/**
 * Shared skills browser. Three surfaces:
 *
 *   - Workspace tab (`surface: "workspace"`) — grouped sections (workspace
 *     editable, inherited-from-org disabled, inherited-from-bundles disabled),
 *     plus a personal-skills footer link. Scope filter and create-scope
 *     picker are suppressed; create is locked to "workspace".
 *   - Org-admin tab (`lockedScope: "org"`) — single-section view of org-tier
 *     skills only. Scope filter and create-scope picker are suppressed;
 *     create is locked to "org".
 *   - Default (no prop) — every scope visible with filter UI. No live
 *     route uses this today; kept for the Phase 1 test seam and as a
 *     debugging surface.
 *
 * Per SKILLS_SURFACE.md (Phase 2). The `surface` prop is intentionally
 * additive to `lockedScope` so the two surfaces can evolve independently
 * — they share the underlying state machine but render different layouts.
 */
type DetailMode = "view" | "edit";

interface SkillsBrowserProps {
  /** Single-scope view. Hides the scope filter; locks the create form to
   * the given writable scope when "org" / "workspace" / "user". */
  lockedScope?: Scope;
  /** Layout variant. `"workspace"` renders the four-section workspace tab
   * (workspace editable + inherited-org + inherited-bundles + personal
   * footer) with the scope filter hidden and create locked to workspace. */
  surface?: "workspace";
}

export function SkillsBrowser({ lockedScope, surface }: SkillsBrowserProps = {}) {
  const isWorkspaceSurface = surface === "workspace";
  // Workspace surface needs every scope's skills in one fetch so the
  // inherited sections and personal-footer count are accurate. Org surface
  // continues to pre-scope its fetch via `lockedScope`. The default ("show
  // everything") path uses whatever the user selects in the filter.
  const initialScopeFilter: Scope | "all" = isWorkspaceSurface ? "all" : (lockedScope ?? "all");
  const createLockedScope: WritableScope | undefined = isWorkspaceSurface
    ? "workspace"
    : lockedScope === "org"
      ? "org"
      : undefined;
  const [skills, setSkills] = useState<ListedSkill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReadSkill | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // When the surface is scope-locked OR is the workspace tab, the scope
  // filter UI is hidden. For the lock case, default the state to the lock
  // so the first fetch is already scoped (no flash of "all"). For the
  // workspace tab, default to "all" — the grouped layout pulls every scope
  // in one request and partitions in the renderer.
  const [scopeFilter, setScopeFilter] = useState<Scope | "all">(initialScopeFilter);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("active");
  const [mode, setMode] = useState<DetailMode>("view");
  const [creating, setCreating] = useState(false);
  const [actionPending, setActionPending] = useState(false);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const args: Record<string, unknown> = {};
      if (scopeFilter !== "all") args.scope = scopeFilter;
      if (statusFilter !== "all") args.status = statusFilter;
      const res = await callTool("skills", "list", args);
      const data = parseToolResponse<SkillsListOutput>(res);
      setSkills(data.skills);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load skills.";
      setError(msg);
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [scopeFilter, statusFilter]);

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  // When the catalog reloads, refresh the open detail panel if its skill is
  // still in view; otherwise drop the selection.
  useEffect(() => {
    if (!selectedId) return;
    if (!skills.some((s) => s.id === selectedId)) {
      setSelectedId(null);
      setDetail(null);
      setMode("view");
    }
  }, [skills, selectedId]);

  // Fetch the detail body whenever selection changes.
  const fetchDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await callTool("skills", "read", { id });
      const data = parseToolResponse<ReadSkill>(res);
      setDetail(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to read skill.";
      setError(msg);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setMode("view");
      return;
    }
    void fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  const handleSelect = useCallback((id: string) => {
    setMode("view");
    setCreating(false);
    setError(null);
    setSelectedId(id);
  }, []);

  const handleStartCreate = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setMode("view");
    setCreating(true);
    setError(null);
  }, []);

  const runMutation = useCallback(
    async (
      tool: string,
      args: Record<string, unknown>,
      onSuccess?: (result: { id?: string }) => void,
    ) => {
      setActionPending(true);
      setError(null);
      try {
        const res = await callTool("skills", tool, args);
        const data = parseToolResponse<{ id?: string; name?: string; scope?: string }>(res);
        await fetchSkills();
        onSuccess?.(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Failed to ${tool} skill.`;
        setError(msg);
      } finally {
        setActionPending(false);
      }
    },
    [fetchSkills],
  );

  const handleCreate = useCallback(
    async (input: CreateInput) => {
      await runMutation("create", input, (result) => {
        setCreating(false);
        if (result.id) setSelectedId(result.id);
      });
    },
    [runMutation],
  );

  const handleSaveEdit = useCallback(
    async (id: string, patch: { manifest: Record<string, unknown>; body: string }) => {
      await runMutation("update", { id, manifest: patch.manifest, body: patch.body }, async () => {
        setMode("view");
        await fetchDetail(id);
      });
    },
    [runMutation, fetchDetail],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this skill? It will be snapshotted to _versions/ first.")) {
        return;
      }
      await runMutation("delete", { id }, () => {
        setSelectedId(null);
        setDetail(null);
        setMode("view");
      });
    },
    [runMutation],
  );

  const handleToggleStatus = useCallback(
    async (id: string, currentStatus: string | undefined) => {
      const tool = currentStatus === "active" ? "deactivate" : "activate";
      await runMutation(tool, { id }, () => {
        void fetchDetail(id);
      });
    },
    [runMutation, fetchDetail],
  );

  const handleMoveScope = useCallback(
    async (id: string, targetScope: WritableScope) => {
      if (
        !window.confirm(
          `Move skill to ${targetScope} scope? The original location is removed (snapshotted first).`,
        )
      ) {
        return;
      }
      await runMutation("move_scope", { id, target_scope: targetScope }, (result) => {
        if (result.id) setSelectedId(result.id);
      });
    },
    [runMutation],
  );

  const grouped = useMemo(
    () => groupByScope(skills, { excludeUser: isWorkspaceSurface }),
    [skills, isWorkspaceSurface],
  );
  // Personal-skills count for the workspace-surface footer. Computed from
  // the same fetch — the workspace tab already pulls every scope so the
  // count is free.
  const personalCount = useMemo(
    () => (isWorkspaceSurface ? skills.filter((s) => s.scope === "user").length : 0),
    [skills, isWorkspaceSurface],
  );
  // Workspace surface: only "workspace" skills are editable in place; org
  // and bundle rows show their detail body read-only, with org rows
  // surfacing a deep link to /org/skills (the org-admin surface) so admins
  // can edit there. Org surface: only "org" is editable; bundles
  // read-only. Anything outside those rules falls through to the existing
  // bundle-as-read-only behavior in SkillDetailView.
  const detailReadOnly = ((): boolean => {
    if (!detail) return false;
    if (detail.scope === "bundle") return true;
    if (isWorkspaceSurface) return detail.scope !== "workspace";
    if (lockedScope) return detail.scope !== lockedScope;
    return false;
  })();
  const detailInheritedFrom = ((): { label: string; href: string } | undefined => {
    if (!detail || !detailReadOnly) return undefined;
    if (detail.scope === "org") return { label: "Edit in org settings", href: "/org/skills" };
    if (detail.scope === "user") return { label: "Edit in your profile", href: "/profile" };
    return undefined;
  })();

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Skills</h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleStartCreate}
          disabled={creating || actionPending}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          New skill
        </Button>
      </header>
      <p className="text-xs text-muted-foreground">
        {lockedScope === "org" ? (
          <>
            Organization-wide skills. These load into every workspace's agent context and apply to
            every member. Authored here or as markdown files under{" "}
            <code>~/.nimblebrain/skills/</code>.
          </>
        ) : isWorkspaceSurface ? (
          <>
            Skills shape your agent's behavior in this workspace. Workspace skills are editable
            here; organization and bundle skills are inherited and read-only. Personal skills follow
            you across every workspace and are managed in your profile.
          </>
        ) : (
          <>
            Layer 3 cross-bundle agent orchestration content (voice, workflow, personal, tool
            routing) plus Layer 1 vendored bundle skills. The agent uses these to shape its
            behavior; you can also author them as markdown files under{" "}
            <code>~/.nimblebrain/skills/</code> (org), <code>workspaces/&lt;wsId&gt;/skills/</code>,
            or <code>users/&lt;userId&gt;/skills/</code>.
          </>
        )}
      </p>

      <Filters
        scope={scopeFilter}
        status={statusFilter}
        onScopeChange={setScopeFilter}
        onStatusChange={setStatusFilter}
        lockedScope={lockedScope}
        hideScopeFilter={isWorkspaceSurface}
      />

      {loading && <div className="text-sm text-muted-foreground">Loading skills…</div>}
      {error && (
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {!loading && !creating && skills.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No skills match the current filters. Click <strong>New skill</strong> to create one,
              or drop a markdown file under any of the skills directories above.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && (creating || skills.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="space-y-4">
            <SkillList
              grouped={grouped}
              selectedId={selectedId}
              onSelect={handleSelect}
              surface={surface}
            />
            {isWorkspaceSurface && <PersonalFooter count={personalCount} />}
          </div>
          {creating ? (
            <CreateForm
              pending={actionPending}
              lockedScope={createLockedScope}
              onCancel={() => {
                setCreating(false);
                setError(null);
              }}
              onSubmit={handleCreate}
            />
          ) : (
            <SkillDetail
              selectedId={selectedId}
              detail={detail}
              loading={detailLoading}
              mode={mode}
              actionPending={actionPending}
              readOnly={detailReadOnly}
              inheritedFrom={detailInheritedFrom}
              onEdit={() => {
                setError(null);
                setMode("edit");
              }}
              onCancelEdit={() => {
                setMode("view");
                setError(null);
              }}
              onSave={(patch) => selectedId && handleSaveEdit(selectedId, patch)}
              onDelete={() => selectedId && handleDelete(selectedId)}
              onToggleStatus={() =>
                selectedId && handleToggleStatus(selectedId, detail?.metadata.status)
              }
              onMoveScope={(target) => selectedId && handleMoveScope(selectedId, target)}
              placeholder={skills.length > 0}
            />
          )}
        </div>
      )}
    </div>
  );
}

type WritableScope = "org" | "workspace" | "user";

// Args shape derived from the schema catalog. `name` lives inside `manifest`
// because that's where the on-disk frontmatter has it — see the original
// SkillsTab incident where the form was sending name at the root and the
// validator rejected it.
type CreateInput = ToolInput<"skills", "create">;

// ── List view ────────────────────────────────────────────────────────────

interface GroupedSkills {
  scope: Scope;
  skills: ListedSkill[];
}

/**
 * Group skills by scope, in the order each surface wants to see them.
 *
 *   - Workspace surface (`excludeUser: true`) shows workspace first
 *     (editable), then org and bundle (inherited / read-only). User-tier
 *     skills are surfaced separately via the personal-footer count, not
 *     as a section in the main list.
 *   - Other surfaces (`excludeUser: false`) show every scope, ordered
 *     user → workspace → org → bundle — the historical browse order.
 */
function groupByScope(skills: ListedSkill[], opts?: { excludeUser?: boolean }): GroupedSkills[] {
  const order: Scope[] = opts?.excludeUser
    ? ["workspace", "org", "bundle"]
    : ["user", "workspace", "org", "bundle"];
  const map = new Map<Scope, ListedSkill[]>();
  for (const s of skills) {
    if (opts?.excludeUser && s.scope === "user") continue;
    const list = map.get(s.scope) ?? [];
    list.push(s);
    map.set(s.scope, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return order.filter((s) => map.has(s)).map((scope) => ({ scope, skills: map.get(scope)! }));
}

const SCOPE_LABEL: Record<Scope, string> = {
  user: "User",
  workspace: "Workspace",
  org: "Org",
  bundle: "Bundle (Layer 1)",
};

/**
 * Section header label on the workspace surface — names that make the
 * inheritance relationship explicit ("Inherited from org") rather than
 * the bare scope name. Falls back to SCOPE_LABEL on other surfaces.
 */
const WORKSPACE_SURFACE_SECTION_LABEL: Record<Scope, string> = {
  workspace: "Workspace",
  org: "Inherited from organization",
  bundle: "Inherited from bundles",
  user: "User", // unreachable in practice — workspace surface excludes user
};

function SkillList({
  grouped,
  selectedId,
  onSelect,
  surface,
}: {
  grouped: GroupedSkills[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  surface?: "workspace";
}) {
  const labelFor = (scope: Scope) =>
    surface === "workspace" ? WORKSPACE_SURFACE_SECTION_LABEL[scope] : SCOPE_LABEL[scope];
  return (
    <div className="space-y-4">
      {grouped.map((group) => {
        // Workspace surface: workspace is the only editable scope. Org and
        // bundle rows render dimmed to communicate "you can't edit these
        // from here" — the selected detail panel surfaces the deep-link
        // alternative.
        const inherited = surface === "workspace" && group.scope !== "workspace";
        return (
          <section key={group.scope} className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-1">
              {labelFor(group.scope)}{" "}
              <span className="text-muted-foreground/60 font-normal">({group.skills.length})</span>
            </h3>
            <div className="grid gap-1">
              {group.skills.map((s) => (
                <SkillRow
                  key={s.id}
                  skill={s}
                  selected={s.id === selectedId}
                  onSelect={() => onSelect(s.id)}
                  inherited={inherited}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Workspace-tab footer summarizing the user's personal skills.
 *
 * Personal (user-tier) skills follow the identity across every workspace,
 * so they're authored at the identity-level surface (`/profile`), not
 * inside any one workspace. The workspace tab surfaces them here as a
 * count plus a link out, matching the spec's "footer summary, not an
 * authoring affordance" framing.
 *
 * Phase 3 will promote `/profile` to a tabbed surface and route this link
 * at `/profile/skills`; for now `/profile` is the stable target.
 */
function PersonalFooter({ count }: { count: number }) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-3 px-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <User className="h-3.5 w-3.5" />
          <span>
            {count === 0
              ? "No personal skills active here"
              : `${count} personal skill${count === 1 ? "" : "s"} active here`}
          </span>
          <span className="text-muted-foreground/60">— follow you across every workspace</span>
        </div>
        <Link
          to="/profile"
          className="text-xs text-primary underline-offset-4 hover:underline whitespace-nowrap"
        >
          Edit in profile →
        </Link>
      </CardContent>
    </Card>
  );
}

function SkillRow({
  skill,
  selected,
  onSelect,
  inherited,
}: {
  skill: ListedSkill;
  selected: boolean;
  onSelect: () => void;
  /** When true, render dimmed so the read-only relationship is visible
   * before the user clicks. The row stays clickable so the detail panel
   * still shows the body. */
  inherited?: boolean;
}) {
  return (
    <Card
      className={cn(
        "cursor-pointer transition-colors",
        selected ? "ring-1 ring-primary border-primary/40" : "hover:bg-muted/40",
        inherited && !selected && "opacity-70",
      )}
    >
      <CardContent className="py-2.5 px-3">
        <button
          type="button"
          onClick={onSelect}
          className="w-full flex items-center gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{skill.name}</span>
              {skill.status !== "active" && (
                <Badge variant="outline" className={cn("text-[10px]", STATUS_BADGE[skill.status])}>
                  {skill.status}
                </Badge>
              )}
            </div>
            {skill.description && (
              <div className="text-xs text-muted-foreground truncate mt-0.5">
                {skill.description}
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Badge variant="outline" className={cn("text-[10px]", SCOPE_BADGE[skill.scope])}>
              L{skill.layer} · {skill.scope}
            </Badge>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {formatTokens(skill.tokens)} tok
            </span>
          </div>
        </button>
      </CardContent>
    </Card>
  );
}

// ── Detail panel ─────────────────────────────────────────────────────────

interface SkillDetailProps {
  selectedId: string | null;
  detail: ReadSkill | null;
  loading: boolean;
  mode: DetailMode;
  actionPending: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: { manifest: Record<string, unknown>; body: string }) => void;
  onDelete: () => void;
  onToggleStatus: () => void;
  onMoveScope: (target: WritableScope) => void;
  placeholder: boolean;
  /** When true, hide edit / delete / status / move-scope affordances and
   * (optionally) surface `inheritedFrom` as a deep-link out to the surface
   * where the skill IS editable. Bundles are always read-only; this
   * extends that treatment to org-tier skills viewed from the workspace
   * surface (or any scope viewed from outside its writable surface). */
  readOnly?: boolean;
  inheritedFrom?: { label: string; href: string };
}

function SkillDetail(props: SkillDetailProps) {
  const { selectedId, detail, loading, mode, placeholder } = props;
  if (!selectedId) {
    return (
      <Card className="lg:sticky lg:top-4 self-start">
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          {placeholder ? "Select a skill to see its body and metadata." : null}
        </CardContent>
      </Card>
    );
  }
  if (loading || !detail) {
    return (
      <Card className="lg:sticky lg:top-4 self-start">
        <CardContent className="py-8 text-sm text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }
  if (mode === "edit" && !props.readOnly) {
    return (
      <SkillEditor
        detail={detail}
        actionPending={props.actionPending}
        onCancelEdit={props.onCancelEdit}
        onSave={props.onSave}
      />
    );
  }
  return (
    <SkillDetailView
      detail={detail}
      actionPending={props.actionPending}
      readOnly={props.readOnly ?? false}
      inheritedFrom={props.inheritedFrom}
      onEdit={props.onEdit}
      onDelete={props.onDelete}
      onToggleStatus={props.onToggleStatus}
      onMoveScope={props.onMoveScope}
    />
  );
}

function SkillDetailView({
  detail,
  actionPending,
  onEdit,
  onDelete,
  onToggleStatus,
  onMoveScope,
  readOnly,
  inheritedFrom,
}: { detail: ReadSkill; readOnly: boolean; inheritedFrom?: { label: string; href: string } } & Pick<
  SkillDetailProps,
  "actionPending" | "onEdit" | "onDelete" | "onToggleStatus" | "onMoveScope"
>) {
  const m = detail.metadata;
  const isBundle = detail.scope === "bundle";
  const currentStatus = (m.status ?? "active") as Status;
  return (
    <Card className="lg:sticky lg:top-4 self-start">
      <CardContent className="py-4 px-4 space-y-4">
        <header className="space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold">{m.name}</h3>
              <Badge variant="outline" className={cn("text-[10px]", SCOPE_BADGE[detail.scope])}>
                L{detail.layer} · {detail.scope}
              </Badge>
              <Badge variant="outline" className={cn("text-[10px]", STATUS_BADGE[currentStatus])}>
                {currentStatus}
              </Badge>
            </div>
            {!readOnly && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" onClick={onEdit} disabled={actionPending}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onToggleStatus}
                  disabled={actionPending}
                >
                  {currentStatus === "active" ? "Deactivate" : "Activate"}
                </Button>
                <ScopeMover
                  current={detail.scope as WritableScope}
                  pending={actionPending}
                  onMove={onMoveScope}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onDelete}
                  disabled={actionPending}
                  aria-label="Delete skill"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            {readOnly && inheritedFrom && (
              <Link
                to={inheritedFrom.href}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                {inheritedFrom.label} →
              </Link>
            )}
          </div>
          {m.description && <p className="text-xs text-muted-foreground">{m.description}</p>}
          {readOnly && isBundle && (
            <p className="text-[11px] text-muted-foreground italic">
              Bundle (Layer 1) skills are vendored — edit them through the bundle's own settings.
            </p>
          )}
          {readOnly && !isBundle && (
            <p className="text-[11px] text-muted-foreground italic">
              Inherited from {detail.scope} scope — read-only from this surface.
            </p>
          )}
        </header>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {m.type && <Row label="Type" value={m.type} />}
          {m.priority !== undefined && <Row label="Priority" value={String(m.priority)} />}
          {m.loadingStrategy && <Row label="Loads" value={m.loadingStrategy} />}
          {m.appliesToTools && m.appliesToTools.length > 0 && (
            <Row label="Tool affinity" value={m.appliesToTools.join(", ")} mono />
          )}
          {detail.modifiedAt && <Row label="Modified" value={formatTime(detail.modifiedAt)} />}
          {detail.source.path && <Row label="Path" value={detail.source.path} mono />}
          {detail.source.uri && <Row label="URI" value={detail.source.uri} mono />}
          {m.derivedFrom && <Row label="Derived from" value={m.derivedFrom} mono />}
        </dl>

        {m.overrides && m.overrides.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Overrides</div>
            <ul className="text-xs space-y-1 list-disc list-inside">
              {m.overrides.map((o) => (
                <li key={`${o.bundle ?? ""}-${o.skill ?? ""}-${o.reason}`}>
                  {o.bundle && <code className="text-[11px]">{o.bundle}</code>}
                  {o.bundle && o.skill && " / "}
                  {o.skill && <code className="text-[11px]">{o.skill}</code>}
                  {(o.bundle || o.skill) && " — "}
                  <span className="text-muted-foreground">{o.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Body</div>
          <pre className="rounded border bg-muted/30 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono max-h-[500px] overflow-auto">
            {detail.content}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Editor (shared by edit + create) ─────────────────────────────────────

interface EditorFormState {
  description: string;
  type: "context" | "skill";
  priority: string; // string for input; parsed on save
  status: Status;
  body: string;
}

function SkillEditor({
  detail,
  actionPending,
  onCancelEdit,
  onSave,
}: { detail: ReadSkill } & Pick<SkillDetailProps, "actionPending" | "onCancelEdit" | "onSave">) {
  const m = detail.metadata;
  const [form, setForm] = useState<EditorFormState>({
    description: m.description ?? "",
    type: (m.type as "context" | "skill") ?? "skill",
    priority: m.priority !== undefined ? String(m.priority) : "50",
    status: (m.status as Status) ?? "active",
    body: detail.content,
  });

  const handleSave = () => {
    const priorityNum = Number.parseInt(form.priority, 10);
    const patch: NonNullable<ToolInput<"skills", "update">["manifest"]> = {
      description: form.description,
      type: form.type,
      status: form.status,
      ...(Number.isFinite(priorityNum) ? { priority: priorityNum } : {}),
    };
    onSave({ manifest: patch, body: form.body });
  };

  return (
    <Card className="lg:sticky lg:top-4 self-start">
      <CardContent className="py-4 px-4 space-y-4">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Edit {m.name}</h3>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={onCancelEdit} disabled={actionPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={actionPending}>
              {actionPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </header>

        <ManifestForm form={form} setForm={setForm} />

        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="skill-body-edit">
            Body
          </label>
          <Textarea
            id="skill-body-edit"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            className="font-mono text-[11px] min-h-[300px]"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function CreateForm({
  pending,
  lockedScope,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  /** When set, force the create scope and hide the picker. Org-tier-only
   * surfaces pass `"org"` so the form can't author into another scope. */
  lockedScope?: WritableScope;
  onCancel: () => void;
  onSubmit: (input: CreateInput) => void;
}) {
  const [scope, setScope] = useState<WritableScope>(lockedScope ?? "workspace");
  const [name, setName] = useState("");
  const [form, setForm] = useState<EditorFormState>({
    description: "",
    type: "skill",
    priority: "50",
    status: "active",
    body: "",
  });

  const handleSubmit = () => {
    if (!name.trim()) return;
    const priorityNum = Number.parseInt(form.priority, 10);
    const manifest: CreateInput["manifest"] = {
      name: name.trim(),
      description: form.description,
      type: form.type,
      status: form.status,
      ...(Number.isFinite(priorityNum) ? { priority: priorityNum } : {}),
    };
    onSubmit({ scope, manifest, body: form.body });
  };

  return (
    <Card className="lg:sticky lg:top-4 self-start">
      <CardContent className="py-4 px-4 space-y-4">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">New skill</h3>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </div>
        </header>

        <div className={cn("grid gap-3", lockedScope ? "grid-cols-1" : "grid-cols-2")}>
          {lockedScope === undefined && (
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="skill-scope">
                Scope
              </label>
              <select
                id="skill-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as WritableScope)}
                className="rounded-md border bg-background px-2 py-1 text-xs w-full focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="user">User</option>
                <option value="workspace">Workspace</option>
                <option value="org">Org</option>
              </select>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="skill-name">
              Name
            </label>
            <Input
              id="skill-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="voice-rules"
              pattern="[a-zA-Z0-9_-]+"
            />
          </div>
        </div>

        <ManifestForm form={form} setForm={setForm} />

        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="skill-body-new">
            Body
          </label>
          <Textarea
            id="skill-body-new"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            className="font-mono text-[11px] min-h-[200px]"
            placeholder="Markdown content of the skill…"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ManifestForm({
  form,
  setForm,
}: {
  form: EditorFormState;
  setForm: (f: EditorFormState) => void;
}) {
  const selectClass =
    "rounded-md border bg-background px-2 py-1 text-xs w-full focus:outline-none focus:ring-1 focus:ring-ring";
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs font-medium" htmlFor="skill-description">
          Description
        </label>
        <Input
          id="skill-description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="One-line summary of what this skill does"
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="skill-type">
            Type
          </label>
          <select
            id="skill-type"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as EditorFormState["type"] })}
            className={selectClass}
          >
            <option value="skill">skill (triggered)</option>
            <option value="context">context (always-on)</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="skill-priority">
            Priority
          </label>
          <Input
            id="skill-priority"
            type="number"
            min="11"
            max="99"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="skill-status">
            Status
          </label>
          <select
            id="skill-status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as Status })}
            className={selectClass}
          >
            <option value="active">active</option>
            <option value="draft">draft</option>
            <option value="disabled">disabled</option>
            <option value="archived">archived</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function ScopeMover({
  current,
  pending,
  onMove,
}: {
  current: WritableScope;
  pending: boolean;
  onMove: (target: WritableScope) => void;
}) {
  const targets: WritableScope[] = (["org", "workspace", "user"] as WritableScope[]).filter(
    (s) => s !== current,
  );
  return (
    <select
      onChange={(e) => {
        const v = e.target.value as WritableScope | "";
        if (v) onMove(v);
        e.target.value = "";
      }}
      defaultValue=""
      disabled={pending}
      aria-label="Move skill to a different scope"
      className="rounded-md border bg-background px-2 py-1 text-xs h-8 disabled:opacity-50"
    >
      <option value="">Move to…</option>
      {targets.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("break-all", mono && "font-mono text-[11px]")}>{value}</dd>
    </>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// ── Filters ──────────────────────────────────────────────────────────────

const SCOPE_OPTIONS: Array<{ value: Scope | "all"; label: string }> = [
  { value: "all", label: "All scopes" },
  { value: "user", label: "User" },
  { value: "workspace", label: "Workspace" },
  { value: "org", label: "Org" },
  { value: "bundle", label: "Bundle (L1)" },
];

const STATUS_OPTIONS: Array<{ value: Status | "all"; label: string }> = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "disabled", label: "Disabled" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All statuses" },
];

function Filters({
  scope,
  status,
  onScopeChange,
  onStatusChange,
  lockedScope,
  hideScopeFilter,
}: {
  scope: Scope | "all";
  status: Status | "all";
  onScopeChange: (s: Scope | "all") => void;
  onStatusChange: (s: Status | "all") => void;
  /** When set, suppress the scope selector — the surface is scope-locked. */
  lockedScope?: Scope;
  /** When true, suppress the scope selector for a grouped layout that
   * partitions scopes in the renderer rather than filtering at fetch time. */
  hideScopeFilter?: boolean;
}) {
  const selectClass =
    "rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring";
  const showScopeFilter = lockedScope === undefined && !hideScopeFilter;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {showScopeFilter && (
        <select
          value={scope}
          onChange={(e) => onScopeChange(e.target.value as Scope | "all")}
          className={selectClass}
          aria-label="Filter by scope"
        >
          {SCOPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <select
        value={status}
        onChange={(e) => onStatusChange(e.target.value as Status | "all")}
        className={selectClass}
        aria-label="Filter by status"
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
