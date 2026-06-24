import { Lightbulb, Trash2, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Streamdown } from "streamdown";
import type { ToolInput } from "../../_generated/platform-schemas/catalog";
import { callTool } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { parseToolResponse } from "../../lib/tool-response";
import { cn } from "../../lib/utils";
import { RequireActiveWorkspace, Section, SettingsPageHeader } from "./components";

import type {
  SkillDetail as ReadSkill,
  SkillScope as Scope,
  SkillsListOutput,
  SkillSummary as ListedSkill,
} from "../../_generated/platform-schemas/skills";

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
 * Shared skills browser. Each surface picks exactly one prop:
 *
 *   - `surface="workspace"` — grouped sections (workspace editable +
 *     inherited org disabled + inherited bundles disabled) + personal
 *     footer + create locked to workspace.
 *   - `lockedScope="org"` — single-scope org-tier view + create locked
 *     to org. (OrgSkillsTab.)
 *   - `lockedScope="user"` — single-scope user-tier view + create locked
 *     to user. (ProfileSkillsTab.)
 *
 * The discriminated union prevents a caller from passing neither — the
 * "show every scope" fallback isn't reachable from any route.
 */
type SkillsBrowserProps =
  | { surface: "workspace"; lockedScope?: never }
  | { lockedScope: "org" | "user"; surface?: never };

type WritableScope = "org" | "workspace" | "user";

export function SkillsBrowser(props: SkillsBrowserProps) {
  const isWorkspaceSurface = props.surface === "workspace";
  const lockedScope = isWorkspaceSurface ? undefined : props.lockedScope;
  const initialScopeFilter: Scope | "all" = isWorkspaceSurface ? "all" : lockedScope!;
  const createLockedScope: WritableScope = isWorkspaceSurface ? "workspace" : lockedScope!;

  const [skills, setSkills] = useState<ListedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReadSkill | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [view, setView] = useState<"list" | "edit">("list");
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const args: Record<string, unknown> = {};
      if (initialScopeFilter !== "all") args.scope = initialScopeFilter;
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
  }, [initialScopeFilter]);

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
      if (!window.confirm("Delete this rule? It will be snapshotted to _versions/ first.")) return;
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

  const grouped = useMemo(
    () => groupByScope(skills, { excludeUser: isWorkspaceSurface }),
    [skills, isWorkspaceSurface],
  );
  const personalCount = useMemo(
    () => (isWorkspaceSurface ? skills.filter((s) => s.scope === "user").length : 0),
    [skills, isWorkspaceSurface],
  );

  if (view === "edit") {
    const existing = editingId && detail?.id === editingId ? detail : null;
    return (
      <EditView
        existing={existing}
        loading={editingId !== null && (!detail || detail.id !== editingId)}
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
        description={
          lockedScope === "org"
            ? "Organization-wide rules. These apply to every workspace."
            : isWorkspaceSurface
              ? "Rules that shape what your agent says and how it works in this workspace."
              : "Rules that shape your agent's behavior."
        }
        icon={<Lightbulb className="h-5 w-5" />}
      />

      {/* Loading message only when we have nothing to render yet — a
       * refetch triggered by a toggle/edit keeps the list mounted so the
       * accordion's per-row `shellH` state doesn't reset to 0 mid-flight
       * (which manifested as a flicker collapse). */}
      {loading && skills.length === 0 && (
        <div className="text-sm text-muted-foreground py-4">Loading rules…</div>
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
            <p className="text-sm text-muted-foreground">
              No rules here yet. Click <strong>+ Add a rule</strong> below to write one.
            </p>
          </CardContent>
        </Card>
      )}

      {skills.length > 0 &&
        grouped.map((group, idx) => {
          const inherited = isWorkspaceSurface && group.scope !== "workspace";
          const activeCount = group.skills.filter((s) => s.status === "active").length;
          if (inherited) {
            return (
              <InheritedSection
                key={group.scope}
                flush={idx === 0}
                title={
                  group.scope === "org"
                    ? "From your organization"
                    : group.scope === "bundle"
                      ? "From the system"
                      : `From ${group.scope}`
                }
                rules={group.skills}
                deepLinkLabel={group.scope === "org" ? "Edit in org settings" : undefined}
                deepLinkTo={group.scope === "org" ? "/org/skills" : undefined}
                ambient={group.scope === "bundle"}
                expandedId={selectedId}
                onSelect={handleSelect}
                detail={detail}
                detailLoading={detailLoading}
              />
            );
          }
          // Own (editable) section title — `group.scope` always matches
          // one of these three because the list fetch is pre-scoped.
          const ownTitle = isWorkspaceSurface
            ? "From your workspace"
            : group.scope === "org"
              ? "Organization rules"
              : "Your rules";
          return (
            <Section
              key={group.scope}
              flush={idx === 0}
              title={ownTitle}
              action={<span className="text-xs text-muted-foreground">{activeCount} active</span>}
            >
              <div className="divide-y divide-border">
                {group.skills.map((s) => (
                  <Rule
                    key={s.id}
                    skill={s}
                    expanded={selectedId === s.id}
                    detail={selectedId === s.id ? detail : null}
                    detailLoading={selectedId === s.id && detailLoading}
                    onSelect={() => handleSelect(s.id)}
                    onToggle={() => handleToggle(s)}
                    onEdit={() => startEdit(s.id)}
                    onDelete={() => handleDelete(s.id)}
                    pending={actionPending}
                  />
                ))}
              </div>
            </Section>
          );
        })}

      {!loading && (
        <Button
          variant="outline"
          size="sm"
          onClick={startCreate}
          disabled={actionPending}
          className="self-start"
        >
          + Add a rule
        </Button>
      )}

      {isWorkspaceSurface && <PersonalFooter count={personalCount} />}
    </div>
  );
}

// ── Group / partition ────────────────────────────────────────────────────

interface GroupedSkills {
  scope: Scope;
  skills: ListedSkill[];
}

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
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return order.filter((s) => map.has(s)).map((scope) => ({ scope, skills: map.get(scope)! }));
}

// ── Rule row ─────────────────────────────────────────────────────────────

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

/**
 * Human one-liner for how a rule reaches the prompt — surfaced in the expanded
 * view so the loading behavior is visible, not hidden in frontmatter. Rules
 * authored here are always-on; inherited/dynamic skills show their mechanism.
 */
function loadingLabel(skill: ListedSkill): string {
  switch (skill.loading?.mechanism) {
    case "always":
      return "Always on";
    case "tool_affinity":
      return "Loads when a matching tool is active";
    case "trigger":
      return "Loads on a trigger phrase";
    case "none":
      return "Won't auto-load yet";
    default:
      return skill.loadingStrategy === "always" ? "Always on" : "On demand";
  }
}

function Rule({
  skill,
  expanded,
  detail,
  detailLoading,
  inherited,
  onSelect,
  onToggle,
  onEdit,
  onDelete,
  pending,
}: {
  skill: ListedSkill;
  expanded: boolean;
  detail: ReadSkill | null;
  detailLoading: boolean;
  inherited?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  pending: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [shellH, setShellH] = useState(0);
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

  return (
    <div className={cn("py-4", inherited && "opacity-80")}>
      <button
        type="button"
        onClick={onSelect}
        className="w-full text-left grid items-center gap-4 sm:gap-6 grid-cols-[1fr_auto]"
      >
        <div className="min-w-0 pr-1">
          <div className={cn("text-sm leading-snug text-foreground", labelIsName && "font-mono")}>
            {label}
          </div>
        </div>
        <div className="justify-self-end">
          <Toggle
            on={skill.status === "active"}
            onChange={onToggle}
            disabled={inherited}
            label={skill.name}
          />
        </div>
      </button>

      <div
        style={{ maxHeight: shellH, opacity: expanded ? 1 : 0 }}
        className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
        aria-hidden={!expanded}
      >
        <div ref={bodyRef} className="pt-3">
          {detailLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {!detailLoading && detail && detail.id === skill.id && (
            <>
              <div className="max-w-prose text-sm text-foreground/80">
                <Streamdown className="streamdown-container presence-assistant-message">
                  {detail.content}
                </Streamdown>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mt-3 text-xs text-muted-foreground">
                <span>{loadingLabel(skill)}</span>
                {skill.priority != null && <span>· priority {skill.priority}</span>}
                {!labelIsName && <span className="font-mono">· {skill.name}</span>}
              </div>
              {!inherited && (
                <div className="flex gap-4 mt-3">
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
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange();
      }}
      disabled={disabled}
      aria-label={`${on ? "Turn off" : "Turn on"} ${label}`}
      className={cn(
        "inline-flex items-center gap-2 px-2 py-1 rounded-md text-xs font-medium select-none",
        disabled ? "text-muted-foreground/70 cursor-not-allowed" : "text-foreground hover:bg-muted",
      )}
    >
      <span
        className={cn("w-2 h-2 rounded-full", on ? "bg-emerald-500" : "bg-muted-foreground/60")}
      />
      {on ? "On" : "Off"}
    </button>
  );
}

// ── Inherited section ────────────────────────────────────────────────────

/**
 * Inherited (read-only) section — a quiet sibling of `Section` that
 * collapses by default. Uses Section's chrome for consistency: same
 * top-border separator, same `text-sm font-semibold` title vocabulary.
 * The header acts as a button (click toggles open/closed); a chevron
 * sits left of the title to telegraph "this expands".
 *
 * `ambient` shrinks the visual weight further (muted title, slightly
 * dimmed rows) for sections the operator has zero editorial agency
 * over (bundle / system).
 */
function InheritedSection({
  flush,
  title,
  rules,
  deepLinkLabel,
  deepLinkTo,
  ambient,
  expandedId,
  onSelect,
  detail,
  detailLoading,
}: {
  flush?: boolean;
  title: string;
  rules: ListedSkill[];
  deepLinkLabel?: string;
  deepLinkTo?: string;
  ambient?: boolean;
  expandedId: string | null;
  onSelect: (id: string) => void;
  detail: ReadSkill | null;
  detailLoading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = rules.filter((r) => r.status === "active").length;
  return (
    <section className={cn("space-y-3", !flush && "pt-6 border-t border-border/60")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start justify-between gap-4 group"
      >
        <h3
          className={cn(
            "flex items-center gap-2 text-sm font-semibold transition-colors",
            ambient
              ? "text-muted-foreground/80 group-hover:text-foreground"
              : "text-foreground/80 group-hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "text-xs text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          >
            ▸
          </span>
          {title}
        </h3>
        <span className="text-xs text-muted-foreground shrink-0">{activeCount} active</span>
      </button>
      {open && (
        <div className={cn("divide-y divide-border", ambient && "opacity-90")}>
          {rules.map((r) => (
            <Rule
              key={r.id}
              skill={r}
              expanded={expandedId === r.id}
              detail={expandedId === r.id ? detail : null}
              detailLoading={expandedId === r.id && detailLoading}
              onSelect={() => onSelect(r.id)}
              onToggle={() => {}}
              inherited
              pending={false}
            />
          ))}
          {deepLinkLabel && deepLinkTo && (
            <div className="py-3">
              <Link
                to={deepLinkTo}
                className="text-sm text-foreground hover:opacity-70 underline-offset-4 hover:underline"
              >
                {deepLinkLabel} →
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── Personal footer ──────────────────────────────────────────────────────

function PersonalFooter({ count }: { count: number }) {
  return (
    <div className="pt-6 border-t border-border/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <User className="h-3.5 w-3.5" />
        {count === 0
          ? "No personal rules active here."
          : `${count} personal rule${count === 1 ? "" : "s"} active here · follow you across every workspace.`}
      </div>
      <Link
        to="/profile/skills"
        className="text-sm text-foreground hover:opacity-70 underline-offset-4 hover:underline self-start sm:self-auto"
      >
        Edit in your profile →
      </Link>
    </div>
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
        title={loading ? "Loading…" : isNew ? "A new rule for your agent" : "Edit this rule"}
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
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="rule-name">
              Name it
            </label>
            <Input
              id="rule-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
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
              The agent reads this as a rule. Plain English works. Use line breaks for separate
              ideas.
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-2"
            >
              <span
                className={cn(
                  "inline-block text-muted-foreground/60 transition-transform",
                  advancedOpen && "rotate-90",
                )}
              >
                ▸
              </span>
              Advanced
            </button>
            {advancedOpen && (
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
                      onChange={(e) => setPriority(parseInt(e.target.value, 10) || 50)}
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
              // Only forward priority when the user explicitly opened
              // Advanced (or when editing a rule that already had a
              // priority set on disk). For fresh creates with Advanced
              // never opened, omit so the server's default (50) lands —
              // sending `priority: 50` ourselves would be redundant.
              ...(advancedOpen || existing?.metadata.priority !== undefined ? { priority } : {}),
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
