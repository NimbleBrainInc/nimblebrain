import { Lock, Trash2 } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { Streamdown } from "streamdown";
import type { ToolInput } from "../../_generated/platform-schemas/catalog";
import type {
  SkillSummary as ListedSkill,
  SkillDetail as ReadSkill,
  SkillScope as Scope,
  SkillsListOutput,
  SkillsWriteOutput,
} from "../../_generated/platform-schemas/skills";
// The runtime's own predicate and token math, mirrored verbatim by
// `bun run codegen`. The editor answers "will this load, and what does it
// cost?" live, before a save exists to ask the server about — and a
// hand-written second copy of either would drift with nothing to catch it.
import { resolveLoadingMechanism } from "../../_generated/skill-loading";
import { approxTokens } from "../../_generated/skill-tokens";
import { callTool, callToolWithoutWorkspace } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useAutosaveForm } from "../../hooks/useAutosaveForm";
import { roleAtLeast, useCanWriteActiveWorkspace, useScopedRole } from "../../hooks/useScopedRole";
import {
  formatTokenCount,
  skillLoadingSentence,
  skillMechanismLabel,
} from "../../lib/skill-display";
import { linkSafety, rehypePlugins } from "../../lib/streamdown-config";
import { parseToolResponse } from "../../lib/tool-response";
import { cn } from "../../lib/utils";
import type { ToolCallResponse } from "../../types";
import { AutosaveField, RequireActiveWorkspace, SettingsPageHeader } from "./components";
import {
  type LoadingStrategy,
  looksLikeFrontmatter,
  MAX_PRIORITY,
  MIN_PRIORITY,
  parseLines,
  type SkillEditField,
  type SkillEditValues,
  type SkillUpdateArgs,
  skillEditPatch,
} from "./skill-edit-patch";

// ── Wrappers ─────────────────────────────────────────────────────────────

/** Workspace settings tab — `/w/:slug/settings/skills`. */
export function SkillsTab() {
  return (
    <RequireActiveWorkspace>
      <ForActiveWorkspace />
    </RequireActiveWorkspace>
  );
}

/**
 * Keyed by the workspace, so a switch starts a fresh browser: the route keeps
 * this element mounted across `/w/:slug` changes, and one workspace's open
 * editor must never save into another.
 */
function ForActiveWorkspace() {
  const { activeWorkspace } = useWorkspaceContext();
  return <SkillsBrowser key={activeWorkspace?.id} surface="workspace" />;
}

/**
 * Shared skills browser. Every surface is one *vantage* into the same skill
 * stack: the scope it can edit, plus the read-only tiers shown around it for
 * context. One list, one row grammar; the tiers present and the segment filter
 * derive from the data, so a single-scope surface simply shows no filter.
 *
 *   - `surface="workspace"` — edits workspace; shows the full stack (your
 *     personal skills, org policy, the system foundation) as read-only tiers.
 *   - `lockedScope="org"` — edits org. (OrgSkillsTab.)
 *   - `lockedScope="user"` — edits personal. (ProfileSkillsTab.)
 *
 * The discriminated union prevents a caller from passing neither — the
 * "show every scope" fallback isn't reachable from any route.
 */
type SkillsBrowserProps =
  | { surface: "workspace"; lockedScope?: never }
  | { lockedScope: "org" | "user"; surface?: never };

type WritableScope = "org" | "workspace" | "user";

interface ScopeConfig {
  isWorkspaceSurface: boolean;
  lockedScope: "org" | "user" | undefined;
  /** The `scope` argument for `skills__list` ("all" = unfiltered). Distinct from
   *  the UI's segment filter, which always starts at "all". */
  fetchScope: Scope | "all";
  createLockedScope: WritableScope;
}

/** Resolve the scope values a surface / lockedScope combination implies. */
function resolveScopeConfig(props: SkillsBrowserProps): ScopeConfig {
  if (props.surface === "workspace") {
    return {
      isWorkspaceSurface: true,
      lockedScope: undefined,
      fetchScope: "all",
      createLockedScope: "workspace",
    };
  }
  return {
    isWorkspaceSurface: false,
    lockedScope: props.lockedScope,
    fetchScope: props.lockedScope,
    createLockedScope: props.lockedScope,
  };
}

/** Sub-header copy naming which scope's skills this view manages. */
function headerDescription(lockedScope: "org" | "user" | undefined, isWorkspaceSurface: boolean) {
  if (lockedScope === "org") return "Organization-wide skills. These apply to every workspace.";
  if (isWorkspaceSurface)
    return "Everything shaping your agent in this workspace, and where it comes from.";
  return "Your personal skills — they follow you into every workspace.";
}

// ── Vantage: which scope a surface edits, and the tiers it renders ──────────
//
// Ordered agency-first: what you control, then what rides along with you, then
// what's set for you. A surface renders only the tiers actually present in its
// data, so org/profile (single-scope fetches) collapse to one tier and drop the
// filter, while the workspace fetch (unscoped) shows the full stack.
const TIER_ORDER: Record<WritableScope, Scope[]> = {
  workspace: ["workspace", "user", "org", "provided"],
  org: ["org"],
  user: ["user"],
};

/** The segment-filter chip label for a scope. */
const SEGMENT_LABEL: Record<Scope, string> = {
  workspace: "Yours",
  user: "You",
  org: "Org",
  provided: "System",
};

/**
 * The chip label for a tier. "Yours" is an ownership claim, so it holds only
 * while the viewer can actually write the tier — otherwise the filter bar would
 * contradict the tier heading two elements below it. Keyed on the scope the
 * string actually names, so the condition and the copy can't drift apart, and
 * reading `tier.editable` keeps the claim to one source.
 */
function segmentLabel(tier: Tier): string {
  if (tier.scope === "workspace" && !tier.editable) return "Workspace";
  return SEGMENT_LABEL[tier.scope];
}

/**
 * A tier's divider label and, when it's read-only on this surface, the deep
 * link to where it *is* edited. The editable tier names itself plainly; a
 * context tier names its provenance and points home.
 */
function tierChrome(
  scope: Scope,
  editable: WritableScope,
  canManageOrg: boolean,
  writable: boolean,
): { label: string; manageTo?: string; manageLabel?: string } {
  // A tier label only renders on a multi-tier surface, which today is only the
  // workspace vantage — so the editable tier's label is the sole reachable one.
  // Org and user get theirs back in the PR that gives those surfaces a context
  // tier. (Which is also why the no-write label below can name the workspace:
  // `canWrite` is only ever false on that vantage.)
  if (scope === editable)
    // "Yours" would claim an agency a non-admin member doesn't have over this
    // tier — name the tier and who holds the pen instead.
    return { label: writable ? "Yours" : "Workspace · managed by workspace admins" };
  if (scope === "user")
    return {
      label: "You · follows you everywhere",
      manageTo: "/profile/skills",
      manageLabel: "Edit in your profile",
    };
  if (scope === "org")
    return {
      label: "Organization · managed in org settings",
      // The manage link is only shown to org admins — /org/skills is guarded, so
      // for anyone else it would silently bounce to /profile.
      ...(canManageOrg ? { manageTo: "/org/skills", manageLabel: "Manage in org settings" } : {}),
    };
  // The only other context tier any surface renders is the system connector.
  return { label: "System · built in" };
}

/** The loaded detail matching `editingId`, or null while it's absent/stale. */
function matchingDetail(editingId: string | null, detail: ReadSkill | null): ReadSkill | null {
  return editingId && detail?.id === editingId ? detail : null;
}

/**
 * `skills__update`, sent to the scope this browser edits. A workspace save
 * names the workspace the browser was opened on: the workspace wrapper keys the
 * browser by it, so a queued save can never land in a workspace switched to
 * since. The org and profile vantages are in no workspace and send none
 * (ADR-0043).
 */
function useSendSkillUpdate(lockedScope: "org" | "user" | undefined) {
  const { activeWorkspace } = useWorkspaceContext();
  const workspaceId = activeWorkspace?.id;
  return useCallback(
    async (args: SkillUpdateArgs): Promise<ToolCallResponse> => {
      if (lockedScope) return callToolWithoutWorkspace("skills", "update", args);
      if (!workspaceId) throw new Error("No workspace is open, so the change was not saved.");
      return callTool("skills", "update", args, { workspaceId });
    },
    [lockedScope, workspaceId],
  );
}

export function SkillsBrowser(props: SkillsBrowserProps) {
  const { isWorkspaceSurface, lockedScope, fetchScope, createLockedScope } =
    resolveScopeConfig(props);
  const role = useScopedRole();
  const canWriteActiveWorkspace = useCanWriteActiveWorkspace();
  // /org/skills is org-admin-guarded, so the org tier's "Manage in org settings"
  // deep link would dead-end at the route guard for anyone else. Gate it on the
  // viewer's role (independent of route) so only those who can act see it.
  const canManageOrg = roleAtLeast(role, "org_admin");
  // Workspace-scope writes require workspace admin server-side
  // (`canWriteWorkspaceScoped`), so offering a plain member a live toggle and an
  // Edit button just defers the refusal to save time. Reflect it up front and
  // let the tier render with the same locked treatment context tiers use.
  //
  // The other two vantages need no gate here: /org/skills is already org-admin
  // route-guarded, and a user may always write their own profile.
  const canWrite = createLockedScope !== "workspace" || canWriteActiveWorkspace;
  // The org and profile vantages are in no workspace: their skills are read and
  // written with none (ADR-0043), so no workspace tier is merged into the list.
  const callSkills = lockedScope ? callToolWithoutWorkspace : callTool;

  const [skills, setSkills] = useState<ListedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // What the last save did that the form didn't ask for — today, the manifest
  // fields a pasted SKILL.md set. A save that quietly overrides the form is the
  // defect; saying so is the fix, and it belongs on the list because that is
  // where the save lands.
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Read by a save that lands later, to re-read only the row still open.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [detail, setDetail] = useState<ReadSkill | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [view, setView] = useState<"list" | "edit">("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  // Composition-list filter: "all" or a single scope. Only surfaced when the
  // vantage has more than one tier.
  const [segment, setSegment] = useState<Scope | "all">("all");

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const args: Record<string, unknown> = {};
      if (fetchScope !== "all") args.scope = fetchScope;
      // List both active and disabled so the user can see Off rules and
      // turn them back on. The per-row toggle reflects the current state.
      const res = await callSkills("skills", "list", args);
      const data = parseToolResponse<SkillsListOutput>(res);
      setSkills(data.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills.");
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [fetchScope, callSkills]);

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  useEffect(() => {
    if (!selectedId) return;
    if (!skills.some((s) => s.id === selectedId)) {
      setSelectedId(null);
      setDetail(null);
    }
  }, [skills, selectedId]);

  const fetchDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const res = await callSkills("skills", "read", { id });
        const data = parseToolResponse<ReadSkill>(res);
        setDetail(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to read skill.");
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [callSkills],
  );

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  const handleSelect = useCallback((id: string) => {
    setError(null);
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const runMutation = useCallback(
    async (
      tool: string,
      args: Record<string, unknown>,
      onSuccess?: (result: Partial<SkillsWriteOutput>) => void,
    ) => {
      setActionPending(true);
      setError(null);
      setNotice(null);
      try {
        const res = await callSkills("skills", tool, args);
        const data = parseToolResponse<Partial<SkillsWriteOutput>>(res);
        if (data.frontmatterApplied?.length) {
          setNotice(
            `Applied the frontmatter from the document you pasted — it set ${data.frontmatterApplied.join(", ")}. The block itself was not stored as body text.`,
          );
        }
        await fetchSkills();
        onSuccess?.(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${tool} skill.`);
      } finally {
        setActionPending(false);
      }
    },
    [fetchSkills, callSkills],
  );

  // `set_status`, not `activate`/`deactivate`: those two now mute a skill for a
  // single conversation, which is what an agent means by them. This toggle is
  // the durable one — the skill's file, read by every conversation and every
  // workspace — so it is deliberately the surface a human is looking at while
  // they flip it, and the tool behind it is app-only (the model cannot call it).
  const handleToggle = useCallback(
    async (skill: ListedSkill) => {
      const status = skill.status === "active" ? "disabled" : "active";
      await runMutation("set_status", { id: skill.id, status });
    },
    [runMutation],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this skill? It will be snapshotted to _versions/ first.")) return;
      await runMutation("delete", { id }, () => {
        setSelectedId(null);
        setDetail(null);
      });
    },
    [runMutation],
  );

  const handleCreate = useCallback(
    async (draft: CreateDraft) => {
      // The escape hatch, opt-in: a body whose leading `---` is genuinely
      // prose. Default is `apply`, so the ordinary paste just works.
      const frontmatter = draft.keepFrontmatterAsText ? "ignore" : undefined;
      await runMutation(
        "create",
        {
          scope: createLockedScope,
          manifest: {
            name: draft.name,
            // The human title, which is also the row label. The on-disk
            // schema requires it non-empty; a pasted document that states a
            // real description overrides it server-side.
            description: draft.description,
            loadingStrategy: draft.loadingStrategy,
            priority: Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, draft.priority)),
            toolAffinity: draft.toolAffinity,
            triggers: draft.triggers,
          },
          body: draft.body,
          ...(frontmatter ? { frontmatter } : {}),
        },
        (result) => {
          setView("list");
          setEditingId(null);
          // The new skill lands in the editable tier; clear any active filter
          // so it's visible instead of landing behind a segment showing
          // another tier (only edits of an already-shown row stay put).
          setSegment("all");
          if (result.id) setSelectedId(result.id);
        },
      );
    },
    [createLockedScope, runMutation],
  );

  const sendUpdate = useSendSkillUpdate(lockedScope);

  /**
   * Save one field of an open skill. The open row shows, and the next Edit
   * seeds from, `detail`, so it is dropped before the write and re-read after
   * it: a quick second Edit then waits for the saved skill instead of seeding
   * from the one this save replaced. The open form seeded once and does not
   * read `detail` again, so the re-read never overwrites an edit in progress.
   */
  const saveField = useCallback(
    async (id: string, args: SkillUpdateArgs) => {
      setDetail((prev) => (prev?.id === id ? null : prev));
      try {
        const res = await sendUpdate(args);
        // A refusal comes back as a result, not a throw; without this it
        // would be reported as saved.
        if (res.isError) throw new Error(res.content?.[0]?.text ?? "The change was not saved.");
      } finally {
        // The re-reads report their own failures; the write has landed or
        // failed already, and neither re-read changes that. A save that lands
        // after the reader opened another row leaves that row's detail alone.
        await Promise.all([
          fetchSkills(),
          selectedIdRef.current === id ? fetchDetail(id) : Promise.resolve(),
        ]);
      }
    },
    [sendUpdate, fetchSkills, fetchDetail],
  );

  const startCreate = useCallback(() => {
    setEditingId(null);
    setView("edit");
    setError(null);
    setNotice(null);
  }, []);

  const startEdit = useCallback((id: string) => {
    setEditingId(id);
    setView("edit");
    setError(null);
    setNotice(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setView("list");
    setError(null);
    setNotice(null);
  }, []);

  // The vantage's tiers, agency-first, keeping only scopes the fetch returned.
  const tiers = useMemo<Tier[]>(() => {
    const byScope = new Map<Scope, ListedSkill[]>();
    for (const s of skills) {
      const list = byScope.get(s.scope) ?? [];
      list.push(s);
      byScope.set(s.scope, list);
    }
    for (const list of byScope.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return TIER_ORDER[createLockedScope]
      .filter((scope) => byScope.has(scope))
      .map((scope) => ({
        scope,
        skills: byScope.get(scope)!,
        editable: scope === createLockedScope && canWrite,
      }));
  }, [skills, createLockedScope, canWrite]);

  const multiTier = tiers.length > 1;
  const visibleTiers = segment === "all" ? tiers : tiers.filter((t) => t.scope === segment);
  const visibleSkills = visibleTiers.flatMap((t) => t.skills);
  const onCount = visibleSkills.filter((s) => s.status === "active").length;

  // A refetch can drop the tier a filter points at (last skill deleted); fall
  // back to "All" so the list never renders empty behind a stale segment.
  useEffect(() => {
    if (segment !== "all" && !tiers.some((t) => t.scope === segment)) setSegment("all");
  }, [tiers, segment]);

  if (view === "edit" && editingId) {
    return (
      <EditSkillView
        key={editingId}
        id={editingId}
        detail={matchingDetail(editingId, detail)}
        onSave={saveField}
        onBack={cancelEdit}
      />
    );
  }
  if (view === "edit") {
    return (
      <CreateSkillView
        pending={actionPending}
        error={error}
        onCancel={cancelEdit}
        onCreate={handleCreate}
      />
    );
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Skills"
        description={headerDescription(lockedScope, isWorkspaceSurface)}
      />

      {/* Loading message only when we have nothing to render yet — a
       * refetch triggered by a toggle/edit keeps the list mounted so the
       * accordion's per-row `shellH` state doesn't reset to 0 mid-flight
       * (which manifested as a flicker collapse). */}
      {loading && skills.length === 0 && (
        <div className="text-sm text-muted-foreground py-4">Loading skills…</div>
      )}
      {error && (
        <Card className="mb-4">
          <CardContent className="py-3 px-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}
      {notice && (
        <Card className="mb-4">
          <CardContent className="py-3 px-4">
            <p className="text-sm text-muted-foreground">{notice}</p>
          </CardContent>
        </Card>
      )}

      {!loading && skills.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            {/* The copy has to track the affordance — pointing a non-admin at
             * an "+ Add a skill" button their role doesn't render is worse
             * than saying plainly that it isn't theirs to add. */}
            {canWrite ? (
              <p className="text-sm text-muted-foreground">
                No skills here yet. Click <strong>+ Add a skill</strong> below to write one.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No skills here yet. Workspace admins can add them.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {skills.length > 0 && (
        <div className="space-y-3">
          {/* The count always shows; the segment filter only when there's more
           * than one tier to slice (single-scope surfaces have nothing to
           * filter). */}
          <div className="flex items-center gap-3">
            {multiTier && <SegmentBar tiers={tiers} value={segment} onChange={setSegment} />}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {visibleSkills.length} skill{visibleSkills.length === 1 ? "" : "s"} · {onCount} on
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
            {visibleTiers.map((tier) => (
              <TierGroup
                key={tier.scope}
                tier={tier}
                editableScope={createLockedScope}
                canManageOrg={canManageOrg}
                showLabel={multiTier}
                selectedId={selectedId}
                detail={detail}
                detailLoading={detailLoading}
                actionPending={actionPending}
                onSelect={handleSelect}
                onToggle={handleToggle}
                onEdit={startEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && canWrite && (
        <Button
          variant="outline"
          size="sm"
          onClick={startCreate}
          disabled={actionPending}
          className="self-start"
        >
          + Add a skill
        </Button>
      )}
    </div>
  );
}

// ── Tiers / composition list ───────────────────────────────────────────────

interface Tier {
  scope: Scope;
  skills: ListedSkill[];
  /** Whether this surface can edit this tier, or only read it for context. */
  editable: boolean;
}

/** Segmented filter over the composition list — "All" plus one chip per tier. */
function SegmentBar({
  tiers,
  value,
  onChange,
}: {
  tiers: Tier[];
  value: Scope | "all";
  onChange: (value: Scope | "all") => void;
}) {
  const options: Array<Tier | "all"> = ["all", ...tiers];
  return (
    <fieldset className="inline-flex gap-0.5 rounded-md border border-border bg-secondary p-0.5">
      <legend className="sr-only">Filter by tier</legend>
      {options.map((opt) => {
        const scope = opt === "all" ? "all" : opt.scope;
        const active = value === scope;
        return (
          <button
            key={scope}
            type="button"
            onClick={() => onChange(scope)}
            aria-pressed={active}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt === "all" ? "All" : segmentLabel(opt)}
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * One tier inside the composition card: an optional divider label (shown only
 * when the list holds more than one tier), its rows, and — when the tier is
 * read-only here — a deep link to where it's edited. Returns a fragment so its
 * children sit directly under the card's `divide-y`, hairlining every row and
 * band uniformly.
 */
function TierGroup({
  tier,
  editableScope,
  canManageOrg,
  showLabel,
  selectedId,
  detail,
  detailLoading,
  actionPending,
  onSelect,
  onToggle,
  onEdit,
  onDelete,
}: {
  tier: Tier;
  editableScope: WritableScope;
  canManageOrg: boolean;
  showLabel: boolean;
  selectedId: string | null;
  detail: ReadSkill | null;
  detailLoading: boolean;
  actionPending: boolean;
  onSelect: (id: string) => void;
  onToggle: (skill: ListedSkill) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  // `tier.editable` is `scope === editableScope && canWrite`, and this branch of
  // `tierChrome` only reads it where those scopes match — so it already carries
  // `canWrite` and the prop would be a second copy of the same bit.
  const { label, manageTo, manageLabel } = tierChrome(
    tier.scope,
    editableScope,
    canManageOrg,
    tier.editable,
  );
  return (
    <>
      {showLabel && (
        // An `h3` (not a styled div) so the tiers stay reachable by heading
        // navigation — one tier below the page's `h2`, matching `Section`.
        <h3 className="bg-secondary/40 px-3.5 py-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
      )}
      {tier.skills.map((s) => (
        <SkillRow
          key={s.id}
          skill={s}
          editable={tier.editable}
          expanded={selectedId === s.id}
          detail={selectedId === s.id ? detail : null}
          detailLoading={selectedId === s.id && detailLoading}
          onSelect={() => onSelect(s.id)}
          onToggle={() => onToggle(s)}
          onEdit={() => onEdit(s.id)}
          onDelete={() => onDelete(s.id)}
          pending={actionPending}
        />
      ))}
      {manageTo && manageLabel && (
        <div className="px-3.5 py-2.5">
          <Link
            to={manageTo}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {manageLabel} ↗
          </Link>
        </div>
      )}
    </>
  );
}

// ── Skill row ────────────────────────────────────────────────────────────

/**
 * Resting-state label for a row.
 *
 * The body is rendered as full markdown in the expanded view, so using
 * the body's first sentence as the label duplicates content the moment
 * the row opens. Instead: prefer the (short) description if the author
 * wrote one, otherwise fall back to the on-disk identifier (kebab-name).
 * The author-controlled name is the closest thing to a meaningful label
 * for rules without a description.
 */
function rowLabel(skill: ListedSkill): string {
  const desc = skill.description?.trim();
  if (desc && desc.length > 0 && desc.length <= 140) return desc;
  return skill.name;
}

function SkillRow({
  skill,
  editable,
  expanded,
  detail,
  detailLoading,
  onSelect,
  onToggle,
  onEdit,
  onDelete,
  pending,
}: {
  skill: ListedSkill;
  /** Editable on this surface (live toggle + edit/delete), or read-only context. */
  editable: boolean;
  expanded: boolean;
  detail: ReadSkill | null;
  detailLoading: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  pending: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [shellH, setShellH] = useState(0);
  // Pairs the row button's `aria-expanded` with the region it actually
  // controls, so a screen reader can follow the disclosure to its target.
  const bodyId = useId();
  // `detail` isn't read in the effect, but its async content renders inside
  // bodyRef — so when it loads the measured scrollHeight changes. Keeping it as
  // a dependency re-measures on load; it's a deliberate trigger, not dead code.
  // biome-ignore lint/correctness/useExhaustiveDependencies: detail changes the measured DOM height
  useEffect(() => {
    if (!expanded) {
      setShellH(0);
      return;
    }
    requestAnimationFrame(() => {
      if (bodyRef.current) setShellH(bodyRef.current.scrollHeight);
    });
  }, [expanded, detail]);

  const label = rowLabel(skill);
  const labelIsName = label === skill.name;
  // How the skill loads, stated at rest under the name — the discriminator the
  // flat list used to hide until a row was expanded. Same vocabulary as the
  // in-chat ledger's "Using …" line.
  const mechanism = skillMechanismLabel(skill);
  const hasExpandedMeta = skill.priority != null || !labelIsName;

  return (
    <div>
      {/* The row is a plain container holding two *sibling* controls — the
       * expander and the toggle. A `button` may not contain interactive
       * descendants, so nesting the toggle inside the expander left its
       * exposure to assistive tech undefined and made "toggling must not
       * expand the row" rest on `stopPropagation`. As siblings, that
       * separation is structural and needs no event plumbing. */}
      {/* The leading pad and the gap before the toggle are the expander's own
       * padding, so the whole label run expands on click; leaving them on the
       * container cost ~26px that lit up under the cursor and did nothing.
       * What still tints without expanding is the trailing pad past the toggle
       * and the bands above and below it — a strip at the right edge, left as
       * plain padding rather than stretched into either control's hit area. */}
      <div className="flex items-center pr-3.5 transition-colors hover:bg-secondary">
        <button
          type="button"
          onClick={onSelect}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 py-3 pl-3.5 pr-3 text-left",
            // The focus ring is drawn *inside* the row (negative offset): the
            // card clips overflow, so an outset ring would be cut off on the
            // first and last row. The tint alone is ~1.05:1 against the card —
            // nowhere near the 3:1 a focus indicator owes a keyboard user.
            "focus-visible:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
          )}
        >
          {/* Scope tick — a quiet color column so a tier reads at a glance when
           * the list is filtered to "All". Decorative: the tier divider names the
           * scope in words, so the color never carries meaning alone. */}
          <span
            aria-hidden
            className="h-8 w-0.5 shrink-0 rounded-full"
            style={{ background: `var(--scope-${skill.scope})` }}
          />
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate text-sm leading-snug text-foreground",
                labelIsName && "font-mono",
              )}
            >
              {label}
            </span>
            {mechanism && (
              <span
                // The line truncates to keep rows one height; a long trigger
                // list would otherwise clip with nowhere else to read it (the
                // expanded body carries priority and name, not the mechanism).
                title={mechanism.mono ? `${mechanism.text} ${mechanism.mono}` : mechanism.text}
                className="mt-0.5 block truncate text-xs text-muted-foreground"
              >
                {mechanism.text}
                {mechanism.mono && (
                  <>
                    {" "}
                    <span className="font-mono">{mechanism.mono}</span>
                  </>
                )}
              </span>
            )}
          </span>
        </button>
        {/* The tier divider names the scope in words, so the row carries only
         * the tick and the toggle — no redundant per-row scope label. */}
        <Toggle
          on={skill.status === "active"}
          onChange={onToggle}
          disabled={!editable}
          label={skill.name}
        />
      </div>

      <div
        id={bodyId}
        style={{ maxHeight: shellH, opacity: expanded ? 1 : 0 }}
        className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
        aria-hidden={!expanded}
      >
        <div ref={bodyRef} className="px-3.5 pt-1 pb-3 pl-6">
          {detailLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {!detailLoading && detail && detail.id === skill.id && (
            <>
              {/* Settings sans at text-sm — deliberately NOT the chat's serif
               * `presence-assistant-message` voice, so a skill body never
               * outweighs the section titles around it. */}
              <div className="max-w-prose text-sm text-foreground/80">
                <Streamdown
                  className="streamdown-container"
                  linkSafety={linkSafety}
                  rehypePlugins={rehypePlugins}
                >
                  {detail.content}
                </Streamdown>
              </div>
              {hasExpandedMeta && (
                <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {skill.priority != null && <span>priority {skill.priority}</span>}
                  {!labelIsName && <span className="font-mono">{skill.name}</span>}
                </div>
              )}
              {editable && (
                <div className="mt-3 flex gap-4">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit?.();
                    }}
                    disabled={pending}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete?.();
                    }}
                    disabled={pending}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Toggle ───────────────────────────────────────────────────────────────

function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      // A sibling of the row's expander, not a descendant — a click here
      // reaches no other control, so it needs no `stopPropagation`. The
      // `disabled` attribute is what suppresses the locked-tier click.
      onClick={onChange}
      disabled={disabled}
      aria-label={
        disabled
          ? `${label} — ${on ? "on" : "off"}, managed elsewhere`
          : `${on ? "Turn off" : "Turn on"} ${label}`
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 px-2 py-1 rounded-sm text-xs font-medium select-none",
        disabled ? "text-muted-foreground cursor-default" : "text-foreground hover:bg-muted",
      )}
    >
      {disabled && <Lock className="h-3 w-3" aria-hidden />}
      <span className={cn("w-2 h-2 rounded-full", on ? "bg-success" : "bg-muted-foreground/60")} />
      {on ? "On" : "Off"}
    </button>
  );
}

// ── Create and edit views ─────────────────────────────────────────────────

type CreateInput = ToolInput<"skills", "create">;

export type { CreateInput };

/**
 * Slugify a user-typed name into the on-disk identifier shape the server
 * accepts (`^[a-zA-Z0-9_-]+$`). Lowercases, replaces runs of disallowed
 * characters with a single `-`, strips leading/trailing dashes.
 *
 *   "Test 123"          → "test-123"
 *   "Voice / Tone"      → "voice-tone"
 *   "  Already-Good_1"  → "already-good_1"
 */
function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/** The name input of the create form, with the slug it will be saved as. */
function RuleNameField({
  name,
  slug,
  showSlugHint,
  nameRef,
  onChange,
}: {
  name: string;
  slug: string;
  showSlugHint: boolean;
  nameRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor="rule-name">
        Name it
      </label>
      <Input
        id="rule-name"
        ref={nameRef}
        value={name}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Voice rules"
      />
      {showSlugHint && (
        <p className="text-xs text-muted-foreground">
          Saved as <span className="font-mono">{slug}</span>
        </p>
      )}
    </div>
  );
}

// ── The manifest a skill is being authored with ──────────────────────────

/** What the create form hands back on Create. */
interface CreateDraft {
  name: string;
  description: string;
  body: string;
  priority: number;
  loadingStrategy: LoadingStrategy;
  toolAffinity: string[];
  triggers: string[];
  /** Store a leading `---` block as body text instead of reading it as frontmatter. */
  keepFrontmatterAsText: boolean;
}

/**
 * What will happen to this skill, stated while it is still being written.
 *
 * A skill's whole purpose is to load, and a skill that never loads looks like
 * every healthy one everywhere else, so the editor says which it is while the
 * condition can still be changed. The mechanism and the token cost are both
 * derived through the runtime's own code, so the sentence here and the row's
 * after a save are the same verdict.
 *
 * It describes one state, never a mix: the create form's draft, or an open
 * skill as saved. `footnote` says what the state leaves out.
 */
function LoadingVerdict({
  strategy,
  toolAffinity,
  triggers,
  body,
  footnote,
}: {
  strategy: LoadingStrategy;
  toolAffinity: string[];
  triggers: string[];
  body: string;
  footnote?: string;
}) {
  const mechanism = resolveLoadingMechanism({
    loadingStrategy: strategy,
    toolAffinity,
    triggers,
  });
  const sentence = skillLoadingSentence(mechanism, { toolAffinity, triggers });
  const tokens = approxTokens(body);
  return (
    <div
      className={cn(
        "rounded-md border px-3.5 py-3 text-sm",
        sentence.dead ? "border-destructive/40 bg-destructive/5" : "border-border bg-secondary/40",
      )}
    >
      <p className={cn("font-medium", sentence.dead && "text-destructive")}>
        {sentence.text}
        {sentence.mono && (
          <>
            {" "}
            <span className="font-mono font-normal">{sentence.mono}</span>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {/* An always-on skill is paid on every turn, so its cost is stated
         * here. The estimate is the same one `skills__list` reports. */}
        {strategy === "always"
          ? `≈${formatTokenCount(tokens)} tokens in every conversation`
          : `≈${formatTokenCount(tokens)} tokens when it loads`}
        {footnote && ` · ${footnote}`}
      </p>
    </div>
  );
}

/**
 * The `---` block sitting at the top of the body, and what will become of it.
 *
 * Shown before the save rather than reported after it. On create the block
 * configures the new skill. On an existing skill the fields own those values,
 * so the block is never applied: the body's save is held until it is removed or
 * kept as text.
 */
function FrontmatterNotice({
  existing,
  keepAsText,
  onKeepAsTextChange,
}: {
  existing: boolean;
  keepAsText: boolean;
  onKeepAsTextChange: (value: boolean) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 px-3.5 py-3 space-y-2">
      {existing ? (
        <p className="text-sm">
          This starts with a <span className="font-mono">---</span> block. On an existing skill the
          fields below configure it, so a header here is not applied. Remove it, or keep it as text.
        </p>
      ) : (
        <p className="text-sm">
          This starts with a <span className="font-mono">---</span> block. If it's SKILL.md
          frontmatter, its fields configure the skill on save and the block isn't stored as text.
        </p>
      )}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={keepAsText}
          onChange={(e) => onKeepAsTextChange(e.target.checked)}
        />
        Keep it as body text instead
      </label>
    </div>
  );
}

/** A newline-separated list field — tool patterns, trigger phrases. */
function ListField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** The two loading strategies as a radio pair. A choice is a complete edit. */
function StrategyRadios({
  id,
  value,
  onChange,
  invalid,
}: {
  id?: string;
  value: LoadingStrategy;
  onChange: (value: LoadingStrategy) => void;
  invalid?: boolean;
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label="When it loads"
      aria-invalid={invalid || undefined}
      className="flex flex-col gap-1 pt-1"
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="loading-strategy"
          value="always"
          checked={value === "always"}
          onChange={() => onChange("always")}
        />
        Always — in context every conversation
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="loading-strategy"
          value="dynamic"
          checked={value === "dynamic"}
          onChange={() => onChange("dynamic")}
        />
        On demand — only when something below matches
      </label>
    </div>
  );
}

const TOOL_AFFINITY_HINT =
  "One glob per line, e.g. files__*. Loads whenever a matching tool is active.";
const TRIGGERS_HINT = "One phrase per line. Loads whenever the phrase appears in a message.";
const PRIORITY_HINT = `${MIN_PRIORITY}–${MAX_PRIORITY}, lower = read first (default 50)`;

/** The collapsible "Advanced" disclosure the manifest fields sit behind. */
function AdvancedDisclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-2"
      >
        <span className={cn("inline-block transition-transform", open && "rotate-90")}>▸</span>
        Advanced
      </button>
      {open && <div className="mt-4 pl-5 space-y-4 border-l border-border">{children}</div>}
    </div>
  );
}

/**
 * The create form's manifest fields, behind the prose.
 *
 * A `dynamic` skill with neither triggers nor tool-affinity is catalog-only,
 * and with a thin description it never loads. Offering the strategy is safe
 * because `LoadingVerdict` names that outcome the moment the form reaches it.
 */
function CreateAdvancedSection({
  open,
  priority,
  strategy,
  toolAffinity,
  triggers,
  onToggle,
  onPriorityChange,
  onStrategyChange,
  onToolAffinityChange,
  onTriggersChange,
}: {
  open: boolean;
  priority: number;
  strategy: LoadingStrategy;
  toolAffinity: string;
  triggers: string;
  onToggle: () => void;
  onPriorityChange: (value: number) => void;
  onStrategyChange: (value: LoadingStrategy) => void;
  onToolAffinityChange: (value: string) => void;
  onTriggersChange: (value: string) => void;
}) {
  return (
    <AdvancedDisclosure open={open} onToggle={onToggle}>
      <fieldset className="space-y-1">
        <legend className="block text-sm font-medium">When it loads</legend>
        <StrategyRadios value={strategy} onChange={onStrategyChange} />
      </fieldset>

      {/* Shown only for `dynamic`: with `always` these fields still store,
       * but nothing reads them, and a control that does nothing where it
       * sits is the kind of quiet lie this editor avoids. */}
      {strategy === "dynamic" && (
        <>
          <ListField
            id="tool-affinity"
            label="Tool patterns"
            hint={TOOL_AFFINITY_HINT}
            value={toolAffinity}
            placeholder="files__*"
            onChange={onToolAffinityChange}
          />
          <ListField
            id="triggers"
            label="Trigger phrases"
            hint={TRIGGERS_HINT}
            value={triggers}
            placeholder="deploy to staging"
            onChange={onTriggersChange}
          />
        </>
      )}

      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="priority">
          Priority
        </label>
        <div className="flex items-baseline gap-3">
          <input
            id="priority"
            type="number"
            min={MIN_PRIORITY}
            max={MAX_PRIORITY}
            value={priority}
            onChange={(e) => onPriorityChange(parseInt(e.target.value, 10) || 50)}
            className="text-sm bg-background border-b border-border pb-1 w-20 outline-none focus:border-foreground"
          />
          <span className="text-xs text-muted-foreground">{PRIORITY_HINT}</span>
        </div>
      </div>
    </AdvancedDisclosure>
  );
}

/** The body textarea's shared attributes. */
const BODY_PLACEHOLDER = "Match my writing voice. Avoid em-dashes.";
const BODY_HINT = "Plain English works. Use line breaks for separate ideas.";

/**
 * A new skill. Nothing exists to save into until Create, so this form keeps an
 * explicit action and sends every field at once.
 */
function CreateSkillView({
  pending,
  error,
  onCancel,
  onCreate,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (draft: CreateDraft) => void;
}) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [priority, setPriority] = useState<number>(50);
  // A new skill defaults to always-on — the editor's stated purpose is durable
  // prose the agent reads every turn — and the lede below says so rather than
  // leaving it to be discovered after the save.
  const [strategy, setStrategy] = useState<LoadingStrategy>("always");
  const [toolAffinity, setToolAffinity] = useState("");
  const [triggers, setTriggers] = useState("");
  const [keepFrontmatterAsText, setKeepFrontmatterAsText] = useState(false);

  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // The user types anything they want ("Test 123") and we slugify before
  // it reaches the server (which enforces `^[a-zA-Z0-9_-]+$` because the
  // value becomes a filename). Show the slugified form as a hint when it
  // differs from the typed value so the on-disk identity is honest.
  const slug = slugifyName(name);
  const showSlugHint = slug.length > 0 && slug !== name.trim();

  const affinityList = parseLines(toolAffinity);
  const triggerList = parseLines(triggers);
  const frontmatterPending = looksLikeFrontmatter(body) && !keepFrontmatterAsText;

  const valid = slug.length > 0 && body.trim().length > 0;

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="New skill"
        // `onBack` (not `back`) because the editor is component state on
        // SkillsBrowser, not a routed sub-page — the URL stays on
        // .../skills while editing. A router Link would navigate UP the
        // tree (out of skills) and silently drop the form state.
        onBack={{ onClick: onCancel, label: "Back to skills" }}
      />

      {error && (
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          New skills are always on — the agent reads them in every conversation. Change that under{" "}
          <strong>Advanced</strong>, or paste a whole <span className="font-mono">SKILL.md</span>{" "}
          and its frontmatter will set it.
        </p>

        <RuleNameField
          name={name}
          slug={slug}
          showSlugHint={showSlugHint}
          nameRef={nameRef}
          onChange={setName}
        />

        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="rule-body">
            What should the agent do?
          </label>
          <Textarea
            id="rule-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder={BODY_PLACEHOLDER}
          />
          <p className="text-xs text-muted-foreground">{BODY_HINT}</p>
        </div>

        {looksLikeFrontmatter(body) && (
          <FrontmatterNotice
            existing={false}
            keepAsText={keepFrontmatterAsText}
            onKeepAsTextChange={setKeepFrontmatterAsText}
          />
        )}

        <LoadingVerdict
          strategy={strategy}
          toolAffinity={affinityList}
          triggers={triggerList}
          body={body}
          footnote={frontmatterPending ? "the pasted frontmatter may change this" : undefined}
        />

        <CreateAdvancedSection
          open={advancedOpen}
          priority={priority}
          strategy={strategy}
          toolAffinity={toolAffinity}
          triggers={triggers}
          onToggle={() => setAdvancedOpen((v) => !v)}
          onPriorityChange={setPriority}
          onStrategyChange={setStrategy}
          onToolAffinityChange={setToolAffinity}
          onTriggersChange={setTriggers}
        />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-6">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() =>
            valid &&
            onCreate({
              name: slug,
              // The typed title is the human label → on-disk `description`
              // (required non-empty). `name` is its slug (the filename).
              description: name.trim(),
              body: body.trim(),
              priority,
              loadingStrategy: strategy,
              toolAffinity: affinityList,
              triggers: triggerList,
              keepFrontmatterAsText,
            })
          }
          disabled={!valid || pending}
        >
          {pending ? "Creating…" : "Create"}
        </Button>
      </div>
    </div>
  );
}

// ── Editing a skill that exists ──────────────────────────────────────────

const EDIT_LABELS: Record<SkillEditField, string> = {
  body: "Skill body",
  loadingStrategy: "When it loads",
  priority: "Priority",
  toolAffinity: "Tool patterns",
  triggers: "Trigger phrases",
};

/**
 * Every field changes how the skill loads or what it says, in every
 * conversation its scope reaches, the moment it saves, so each save raises a
 * notice with Undo.
 */
const EDIT_NOTICES = Object.fromEntries(
  Object.keys(EDIT_LABELS).map((field) => [field, { undo: true }]),
) as Record<SkillEditField, { undo: true }>;

/** The fields `LoadingVerdict` reads. */
const VERDICT_FIELDS: SkillEditField[] = ["body", "loadingStrategy", "toolAffinity", "triggers"];

/** An existing skill's stored values, as the edit form's field values. */
function toEditValues(skill: ReadSkill): SkillEditValues {
  return {
    body: skill.content,
    loadingStrategy: skill.metadata.loadingStrategy === "dynamic" ? "dynamic" : "always",
    priority: String(skill.metadata.priority ?? 50),
    toolAffinity: (skill.metadata.toolAffinity ?? []).join("\n"),
    triggers: (skill.metadata.triggers ?? []).join("\n"),
  };
}

/**
 * An existing skill: the read it opens from, then a form whose fields save as
 * they change. The read seeds the form once; later re-reads (after each save)
 * refresh the list behind it, never the fields being edited.
 */
function EditSkillView({
  id,
  detail,
  onSave,
  onBack,
}: {
  id: string;
  detail: ReadSkill | null;
  onSave: (id: string, args: SkillUpdateArgs) => Promise<void>;
  onBack: () => void;
}) {
  const [seed, setSeed] = useState<ReadSkill | null>(detail);
  if (!seed && detail) setSeed(detail);
  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={seed ? "Edit this skill" : "Loading…"}
        // `onBack`, not a router link: the editor is component state on
        // SkillsBrowser and the URL stays on .../skills.
        onBack={{ onClick: onBack, label: "Back to skills" }}
      />
      {seed && <EditSkillForm id={id} skill={seed} onSave={onSave} />}
    </div>
  );
}

function EditSkillForm({
  id,
  skill,
  onSave,
}: {
  id: string;
  skill: ReadSkill;
  onSave: (id: string, args: SkillUpdateArgs) => Promise<void>;
}) {
  const initial = useMemo(() => toEditValues(skill), [skill]);
  // A stored body that opens with `---` was kept as text on purpose (the
  // server strips a header it applies), so it starts kept.
  const [keepAsText, setKeepAsText] = useState(() => looksLikeFrontmatter(skill.content));
  const keepAsTextRef = useRef(keepAsText);
  keepAsTextRef.current = keepAsText;
  // What the file holds, field by field, for the loading verdict. The form's
  // drafts can run ahead of it, or fail to reach it.
  const [saved, setSaved] = useState<SkillEditValues>(initial);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const save = useCallback(
    async <K extends SkillEditField>(field: K, value: SkillEditValues[K]) => {
      await onSave(
        id,
        skillEditPatch(id, field, value, { keepHeaderAsText: keepAsTextRef.current }),
      );
    },
    [id, onSave],
  );
  const onSaved = useCallback(
    <K extends SkillEditField>(field: K, value: SkillEditValues[K]) =>
      setSaved((prev) => ({ ...prev, [field]: value })),
    [],
  );
  const form = useAutosaveForm(initial, {
    save,
    onSaved,
    labels: EDIT_LABELS,
    notices: EDIT_NOTICES,
  });
  const { values, revert, commit } = form;

  // Hidden list fields under `always`. One holding an edit not yet saved, or a
  // failed one, would leave a change nobody can see to retry or revert, so it
  // goes back to its saved value (the same rule the Model tab applies).
  const listsShown = values.loadingStrategy === "dynamic";
  const affinityStatus = form.fieldState("toolAffinity").status;
  const triggersStatus = form.fieldState("triggers").status;
  useEffect(() => {
    if (listsShown) return;
    if (affinityStatus === "error" || affinityStatus === "dirty") revert("toolAffinity");
    if (triggersStatus === "error" || triggersStatus === "dirty") revert("triggers");
  }, [listsShown, affinityStatus, triggersStatus, revert]);

  // The verdict describes the skill as saved, so it never mixes saved fields
  // with drafts that may still fail. It names what it leaves out instead.
  const pendingVerdictFields = VERDICT_FIELDS.filter(
    (f) => form.fieldState(f).status !== "clean" && form.fieldState(f).status !== "saved",
  );
  const footnote =
    pendingVerdictFields.length > 0
      ? `as saved; not yet: ${pendingVerdictFields.map((f) => EDIT_LABELS[f].toLowerCase()).join(", ")}`
      : undefined;

  const bodyHasHeader = looksLikeFrontmatter(values.body);
  const onKeepAsTextChange = (keep: boolean) => {
    keepAsTextRef.current = keep;
    setKeepAsText(keep);
    // Keeping the header as text is what the held body save was waiting on.
    if (keep && form.fieldState("body").status === "error") commit("body");
  };

  const listField = (field: "toolAffinity" | "triggers", hint: string, placeholder: string) => (
    <AutosaveField
      id={field === "toolAffinity" ? "tool-affinity" : "triggers"}
      label={EDIT_LABELS[field]}
      hint={hint}
      {...form.fieldState(field)}
    >
      <Textarea
        id={field === "toolAffinity" ? "tool-affinity" : "triggers"}
        rows={3}
        placeholder={placeholder}
        className="font-mono text-xs"
        {...form.textareaProps(field)}
      />
    </AutosaveField>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="rule-name">
          Name
        </label>
        <Input id="rule-name" value={skill.metadata.name} disabled className="font-mono" />
        <p className="text-xs text-muted-foreground">
          Names are immutable — they're the filename on disk. Each field below saves when you leave
          it.
        </p>
      </div>

      <AutosaveField
        id="rule-body"
        label="What should the agent do?"
        hint={BODY_HINT}
        {...form.fieldState("body")}
      >
        <Textarea
          id="rule-body"
          rows={8}
          placeholder={BODY_PLACEHOLDER}
          {...form.textareaProps("body")}
        />
      </AutosaveField>

      {bodyHasHeader && (
        <FrontmatterNotice
          existing
          keepAsText={keepAsText}
          onKeepAsTextChange={onKeepAsTextChange}
        />
      )}

      <LoadingVerdict
        strategy={saved.loadingStrategy}
        toolAffinity={parseLines(saved.toolAffinity)}
        triggers={parseLines(saved.triggers)}
        body={saved.body}
        footnote={footnote}
      />

      <AdvancedDisclosure open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
        <AutosaveField
          id="loading-strategy"
          label={EDIT_LABELS.loadingStrategy}
          {...form.fieldState("loadingStrategy")}
        >
          <StrategyRadios
            id="loading-strategy"
            value={values.loadingStrategy}
            onChange={(v) => commit("loadingStrategy", v)}
            invalid={form.fieldState("loadingStrategy").status === "error"}
          />
        </AutosaveField>

        {/* Shown only for `dynamic`, as on create: under `always` nothing
         * reads them. */}
        {listsShown && listField("toolAffinity", TOOL_AFFINITY_HINT, "files__*")}
        {listsShown && listField("triggers", TRIGGERS_HINT, "deploy to staging")}

        <AutosaveField
          id="priority"
          label={EDIT_LABELS.priority}
          hint={PRIORITY_HINT}
          {...form.fieldState("priority")}
        >
          <Input
            id="priority"
            type="number"
            min={MIN_PRIORITY}
            max={MAX_PRIORITY}
            className="w-24"
            {...form.inputProps("priority")}
          />
        </AutosaveField>
      </AdvancedDisclosure>
    </div>
  );
}
