import { Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Streamdown } from "streamdown";
import type {
  SkillSummary as ListedSkill,
  SkillDetail as ReadSkill,
  SkillScope as Scope,
  SkillsListOutput,
  SkillsWriteOutput,
} from "../../_generated/platform-schemas/skills";
import { callTool, callToolWithoutWorkspace } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { roleAtLeast, useCanWriteActiveWorkspace, useScopedRole } from "../../hooks/useScopedRole";
import { skillMechanismLabel } from "../../lib/skill-display";
import { linkSafety, rehypePlugins } from "../../lib/streamdown-config";
import { parseToolResponse } from "../../lib/tool-response";
import { cn } from "../../lib/utils";
import type { ToolCallResponse } from "../../types";
import { SettingsPageHeader } from "./components";
import {
  type CreateDraft,
  CreateSkillView,
  createSkillArgs,
  EditSkillView,
  Toggle,
} from "./SkillEditor";
import type { SkillUpdateArgs } from "./skill-edit-patch";

/**
 * Shared skills browser. Every surface is one *vantage* into the same skill
 * stack: the scope it can edit, plus the read-only tiers shown around it for
 * context. One list, one row grammar; the tiers present and the segment filter
 * derive from the data, so a single-scope surface simply shows no filter.
 *
 *   - `lockedScope="org"` — edits org. (OrgSkillsTab, the one routed vantage.)
 *   - `surface="workspace"` — edits workspace; shows the full stack (your
 *     personal skills, org policy, the system foundation) as read-only tiers.
 *   - `lockedScope="user"` — edits personal.
 *
 * Workspace and personal skills are managed on Plugins (`SkillPage`), so no
 * route mounts the last two; their suite still exercises the shared editor
 * through them until this browser narrows to the org vantage.
 *
 * The discriminated union prevents a caller from passing neither — the
 * "show every scope" fallback isn't reachable from any route.
 */
type SkillsBrowserProps =
  | {
      surface: "workspace";
      lockedScope?: never;
      /**
       * The read-only skills the workspace's connectors contribute, shown below
       * the list. Connectors are installed per workspace, so only this vantage
       * has them.
       */
      connectorSkills?: ReactNode;
    }
  | { lockedScope: "org" | "user"; surface?: never; connectorSkills?: never };

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
): { label: string; manageTo?: string; manageLabel?: string; toggleNote?: string } {
  // A tier label only renders on a multi-tier surface, which today is only the
  // workspace vantage — so the editable tier's label is the sole reachable one.
  // Org and user get theirs back in the PR that gives those surfaces a context
  // tier. (Which is also why the no-write label below can name the workspace:
  // `canWrite` is only ever false on that vantage.)
  if (scope === editable)
    // "Yours" would claim an agency a non-admin member doesn't have over this
    // tier — name the tier and who holds the pen instead.
    return {
      label: writable ? "Yours" : "Workspace · managed by workspace admins",
      toggleNote: writable ? undefined : "managed by workspace admins",
    };
  if (scope === "user")
    return {
      label: "You · follows you everywhere",
      toggleNote: "managed elsewhere",
      manageTo: "/profile/skills",
      manageLabel: "Edit in your profile",
    };
  if (scope === "org")
    return {
      label: "Organization · managed in org settings",
      toggleNote: "managed elsewhere",
      // The manage link is only shown to org admins — /org/skills is guarded, so
      // for anyone else it would silently bounce to /profile.
      ...(canManageOrg ? { manageTo: "/org/skills", manageLabel: "Manage in org settings" } : {}),
    };
  // The only other context tier any surface renders is the system connector.
  return { label: "System · built in", toggleNote: "built in" };
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
      await runMutation("create", createSkillArgs(createLockedScope, draft), (result) => {
        setView("list");
        setEditingId(null);
        // The new skill lands in the editable tier; clear any active filter
        // so it's visible instead of landing behind a segment showing
        // another tier (only edits of an already-shown row stay put).
        setSegment("all");
        if (result.id) setSelectedId(result.id);
      });
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
      <div data-tour="skills">
        <SettingsPageHeader
          title="Skills"
          description={headerDescription(lockedScope, isWorkspaceSurface)}
        />
      </div>

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

      {props.connectorSkills}
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
  const { label, manageTo, manageLabel, toggleNote } = tierChrome(
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
          disabledNote={toggleNote}
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
  disabledNote,
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
  disabledNote?: string;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `detail` renders inside `bodyRef` when it loads, which changes the height measured here
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
  // How the skill loads, stated at rest under the name, so the discriminator
  // is visible without expanding the row. Same vocabulary as the
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
          disabledNote={disabledNote}
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
