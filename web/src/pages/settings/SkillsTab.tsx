import { Lightbulb, Lock, Trash2 } from "lucide-react";
import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Streamdown } from "streamdown";
import type { ToolInput } from "../../_generated/platform-schemas/catalog";
import type {
  SkillSummary as ListedSkill,
  SkillDetail as ReadSkill,
  SkillScope as Scope,
  SkillsListOutput,
} from "../../_generated/platform-schemas/skills";
import { callTool } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { roleAtLeast, useScopedRole } from "../../hooks/useScopedRole";
import { skillMechanismLabel } from "../../lib/skill-display";
import { linkSafety } from "../../lib/streamdown-config";
import { parseToolResponse } from "../../lib/tool-response";
import { cn } from "../../lib/utils";
import { RequireActiveWorkspace, SettingsPageHeader } from "./components";

// ── Wrappers ─────────────────────────────────────────────────────────────

/** Workspace settings tab — `/w/:slug/settings/skills`. */
export function SkillsTab() {
  return (
    <RequireActiveWorkspace>
      <SkillsBrowser surface="workspace" />
    </RequireActiveWorkspace>
  );
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
  workspace: ["workspace", "user", "org", "bundle"],
  org: ["org"],
  user: ["user"],
};

/** The segment-filter chip label for a scope. */
const SEGMENT_LABEL: Record<Scope, string> = {
  workspace: "Yours",
  user: "You",
  org: "Org",
  bundle: "System",
};

/**
 * The chip label for a tier. "Yours" is an ownership claim, so it holds only
 * while the viewer can actually write the tier — otherwise the filter bar would
 * contradict the tier heading two elements below it. Reads `tier.editable`
 * rather than taking `canWrite` again, so the claim has one source.
 */
function segmentLabel(tier: Tier, editable: WritableScope): string {
  if (tier.scope === editable && !tier.editable) return "Workspace";
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
  // The only other context tier any surface renders is the system bundle.
  return { label: "System · built in" };
}

/** The loaded detail matching `editingId`, or null while it's absent/stale. */
function matchingDetail(editingId: string | null, detail: ReadSkill | null): ReadSkill | null {
  return editingId && detail?.id === editingId ? detail : null;
}

/** Whether the edit view is still waiting on the detail read for `editingId`. */
function isDetailPending(editingId: string | null, detail: ReadSkill | null): boolean {
  return editingId !== null && (!detail || detail.id !== editingId);
}

export function SkillsBrowser(props: SkillsBrowserProps) {
  const { isWorkspaceSurface, lockedScope, fetchScope, createLockedScope } =
    resolveScopeConfig(props);
  const role = useScopedRole();
  const { activeWorkspace } = useWorkspaceContext();
  // /org/skills is org-admin-guarded, so the org tier's "Manage in org settings"
  // deep link would dead-end at the route guard for anyone else. Gate it on the
  // viewer's role (independent of route) so only those who can act see it.
  const canManageOrg = roleAtLeast(role, "org_admin");
  // Workspace-scope writes require workspace admin server-side
  // (`canWriteWorkspaceScoped`), so offering a plain member a live toggle and an
  // Edit button just defers the refusal to save time. Reflect the role up front
  // and let the tier render with the same locked treatment context tiers use.
  //
  // This reads the *membership* role, not `useScopedRole`. That hook resolves an
  // org admin to `org_admin` before it ever looks at the workspace, and
  // `roleAtLeast(…, "ws_admin")` would then pass — but `canWriteWorkspaceScoped`
  // never consults `orgRole` ("there is no org-admin bypass for workspace-scoped
  // writes", `src/workspace/authz.ts`). Gating on the escalated role would hand
  // the affordances to an org admin who is only a *member* here and land them on
  // the 403 this PR exists to prevent. `userRole === "admin"` is precisely the
  // server's condition; `undefined` means not a member, which also denies.
  //
  // The other two vantages need no gate here: /org/skills is already org-admin
  // route-guarded, and a user may always write their own profile.
  const canWrite = createLockedScope !== "workspace" || activeWorkspace?.userRole === "admin";

  const [skills, setSkills] = useState<ListedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      const res = await callTool("skills", "list", args);
      const data = parseToolResponse<SkillsListOutput>(res);
      setSkills(data.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills.");
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [fetchScope]);

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

  const fetchDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await callTool("skills", "read", { id });
      const data = parseToolResponse<ReadSkill>(res);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read skill.");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

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
        setError(err instanceof Error ? err.message : `Failed to ${tool} skill.`);
      } finally {
        setActionPending(false);
      }
    },
    [fetchSkills],
  );

  const handleToggle = useCallback(
    async (skill: ListedSkill) => {
      const tool = skill.status === "active" ? "deactivate" : "activate";
      await runMutation(tool, { id: skill.id });
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

  const handleSubmit = useCallback(
    async (patch: { name: string; description: string; body: string; priority?: number }) => {
      // A "rule" is an always-on skill: prose the agent reads every turn.
      // Create writes the full manifest; update is a partial patch.
      //
      // On UPDATE we send only the fields this editor owns (priority, body),
      // and deliberately omit description and name:
      //   - description doubles as the row label (`rowLabel`); it's set from
      //     the title at create and left alone. Patching it to "" would wipe
      //     a label authored here or a richer description set via CLI/chat.
      //   - name is the filename — immutable; sending it is a no-op at best,
      //     a silent rename attempt at worst.
      //
      // On CREATE we set the three fields that make a rule actually load:
      //   - loadingStrategy: "always" — a rule is in context every turn. The
      //     server default ("dynamic") with no triggers/tool-affinity is
      //     catalog-only, i.e. it never loads; always-on is the point of a
      //     rule. Always-on skills ride the stable cached prompt prefix.
      //   - description: the human title (also the row label). The on-disk
      //     schema requires it non-empty; for an always-on rule it's a label,
      //     not an activation signal, so the title is the honest value.
      //   - priority (when set): clamped to the schema's 11–99 band.
      const advancedOverrides = {
        ...(patch.priority !== undefined
          ? { priority: Math.min(99, Math.max(11, patch.priority)) }
          : {}),
      };
      if (editingId) {
        await runMutation(
          "update",
          { id: editingId, manifest: advancedOverrides, body: patch.body },
          () => {
            setView("list");
            setEditingId(null);
          },
        );
      } else {
        const createManifest = {
          name: patch.name,
          description: patch.description,
          loadingStrategy: "always",
          ...advancedOverrides,
        };
        await runMutation(
          "create",
          { scope: createLockedScope, manifest: createManifest, body: patch.body },
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
      }
    },
    [editingId, createLockedScope, runMutation],
  );

  const startCreate = useCallback(() => {
    setEditingId(null);
    setView("edit");
    setError(null);
  }, []);

  const startEdit = useCallback((id: string) => {
    setEditingId(id);
    setView("edit");
    setError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setView("list");
    setError(null);
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

  if (view === "edit") {
    return (
      <EditView
        existing={matchingDetail(editingId, detail)}
        loading={isDetailPending(editingId, detail)}
        pending={actionPending}
        error={error}
        onCancel={cancelEdit}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Skills"
        description={headerDescription(lockedScope, isWorkspaceSurface)}
        icon={<Lightbulb className="h-5 w-5" />}
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
            {multiTier && (
              <SegmentBar
                tiers={tiers}
                editableScope={createLockedScope}
                value={segment}
                onChange={setSegment}
              />
            )}
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
  editableScope,
  value,
  onChange,
}: {
  tiers: Tier[];
  editableScope: WritableScope;
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
            {opt === "all" ? "All" : segmentLabel(opt, editableScope)}
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
  // in-chat ledger's "Following …" line.
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
                <Streamdown className="streamdown-container" linkSafety={linkSafety}>
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
        disabled ? "text-muted-foreground/70 cursor-default" : "text-foreground hover:bg-muted",
      )}
    >
      {disabled && <Lock className="h-3 w-3" aria-hidden />}
      <span className={cn("w-2 h-2 rounded-full", on ? "bg-success" : "bg-muted-foreground/60")} />
      {on ? "On" : "Off"}
    </button>
  );
}

// ── Edit view ────────────────────────────────────────────────────────────

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

/** Header title for the edit view across its loading / new / edit states. */
function editViewTitle(loading: boolean, isNew: boolean): string {
  if (loading) return "Loading…";
  // The authoring flow only makes always-on skills, so it names what it makes.
  return isNew ? "A new always-on skill" : "Edit this skill";
}

/** Name input with a slug hint (new) or an immutability note (edit). */
function RuleNameField({
  name,
  isNew,
  slug,
  showSlugHint,
  nameRef,
  onChange,
}: {
  name: string;
  isNew: boolean;
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
        disabled={!isNew}
        className={isNew ? "" : "font-mono"}
      />
      {showSlugHint && (
        <p className="text-xs text-muted-foreground">
          Saved as <span className="font-mono">{slug}</span>
        </p>
      )}
      {!isNew && (
        <p className="text-xs text-muted-foreground">
          Names are immutable — they're the filename on disk.
        </p>
      )}
    </div>
  );
}

/** Collapsible advanced controls — currently just the priority knob. */
function AdvancedSection({
  open,
  priority,
  onToggle,
  onPriorityChange,
}: {
  open: boolean;
  priority: number;
  onToggle: () => void;
  onPriorityChange: (value: number) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-2"
      >
        <span
          className={cn(
            "inline-block text-muted-foreground/60 transition-transform",
            open && "rotate-90",
          )}
        >
          ▸
        </span>
        Advanced
      </button>
      {open && (
        <div className="mt-4 pl-5 space-y-4 border-l border-border">
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="priority">
              Priority
            </label>
            <div className="flex items-baseline gap-3">
              <input
                id="priority"
                type="number"
                min={11}
                max={99}
                value={priority}
                onChange={(e) => onPriorityChange(parseInt(e.target.value, 10) || 50)}
                className="text-sm bg-background border-b border-border pb-1 w-20 outline-none focus:border-foreground"
              />
              <span className="text-xs text-muted-foreground">
                11–99, lower = read first (default 50)
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EditView({
  existing,
  loading,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  existing: ReadSkill | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (patch: { name: string; description: string; body: string; priority?: number }) => void;
}) {
  const isNew = existing === null && !loading;
  const [name, setName] = useState(existing?.metadata.name ?? "");
  const [body, setBody] = useState(existing?.content ?? "");
  // Priority is the only knob this editor exposes. loadingStrategy is fixed
  // to "always" for every rule (set in handleSubmit), so there's no control
  // for it — a rule is, by definition, always on. Dynamic skills (triggers /
  // tool-affinity) are authored by the agent or CLI, not here.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [priority, setPriority] = useState<number>(existing?.metadata.priority ?? 50);

  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (isNew) nameRef.current?.focus();
  }, [isNew]);

  // Sync form to a freshly-loaded detail (e.g. user clicked Edit on a
  // different rule before the prior read resolved).
  useEffect(() => {
    if (existing) {
      setName(existing.metadata.name);
      setBody(existing.content);
      setPriority(existing.metadata.priority ?? 50);
    }
  }, [existing]);

  // The user types anything they want ("Test 123") and we slugify before
  // it reaches the server (which enforces `^[a-zA-Z0-9_-]+$` because the
  // value becomes a filename). Show the slugified form as a hint when it
  // differs from the typed value so the on-disk identity is honest.
  const slug = slugifyName(name);
  const showSlugHint = isNew && slug.length > 0 && slug !== name.trim();

  const valid = slug.length > 0 && body.trim().length > 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <SettingsPageHeader
        title={editViewTitle(loading, isNew)}
        // `onBack` (not `back`) because EditView is component state on
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

      {!loading && (
        <div className="space-y-6">
          <RuleNameField
            name={name}
            isNew={isNew}
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
              placeholder="Match my writing voice. Avoid em-dashes."
            />
            <p className="text-xs text-muted-foreground">
              The agent reads this skill every conversation. Plain English works. Use line breaks
              for separate ideas.
            </p>
          </div>

          <AdvancedSection
            open={advancedOpen}
            priority={priority}
            onToggle={() => setAdvancedOpen((v) => !v)}
            onPriorityChange={setPriority}
          />
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-6">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() =>
            valid &&
            onSubmit({
              name: slug,
              // The typed title is the human label → on-disk `description`
              // (required non-empty). `name` is its slug (the filename). On
              // edit the title is immutable and description is left untouched.
              description: name.trim(),
              body: body.trim(),
              // Always send priority: on a new rule it's the default (50),
              // on an edit it's the rule's current value (so a body-only edit
              // writes it back unchanged). handleSubmit clamps it to 11–99.
              priority,
            })
          }
          disabled={!valid || pending}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
