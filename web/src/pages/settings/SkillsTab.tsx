import { Lightbulb, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
// Mirror the shapes returned by the `nb__skills` source. We don't import
// from the server-side TS to keep the web client decoupled — duplication
// is acceptable here since these are stable contract types and any drift
// surfaces immediately in the UI.

type Layer = 1 | 3;
type Scope = "org" | "workspace" | "user" | "bundle";
type Status = "active" | "draft" | "disabled" | "archived";

interface ListedSkill {
  id: string;
  name: string;
  layer: Layer;
  scope: Scope;
  status: Status;
  type?: string;
  tokens: number;
  source: { bundle?: string; bundleVersion?: string; path?: string; uri?: string };
  description?: string;
  modifiedAt?: string;
  loadingStrategy?: string;
  appliesToTools?: string[];
  priority?: number;
}

interface ReadSkill {
  id: string;
  content: string;
  layer: Layer;
  scope: Scope;
  source: ListedSkill["source"];
  metadata: {
    name: string;
    description?: string;
    type?: string;
    priority?: number;
    loadingStrategy?: string;
    appliesToTools?: string[];
    status?: string;
    overrides?: Array<{ bundle?: string; skill?: string; reason: string }>;
    derivedFrom?: string;
  };
  modifiedAt?: string;
}

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
      <Inner />
    </RequireActiveWorkspace>
  );
}

type DetailMode = "view" | "edit";

function Inner() {
  const [skills, setSkills] = useState<ListedSkill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReadSkill | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<Scope | "all">("all");
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
      const data = parseToolResponse<{ skills: ListedSkill[] }>(res);
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
      await runMutation(
        "create",
        {
          scope: input.scope,
          name: input.name,
          manifest: input.manifest,
          body: input.body,
        },
        (result) => {
          setCreating(false);
          if (result.id) setSelectedId(result.id);
        },
      );
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

  const grouped = useMemo(() => groupByScope(skills), [skills]);

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
        Layer 3 cross-bundle agent orchestration content (voice, workflow, personal, tool routing)
        plus Layer 1 vendored bundle skills. The agent uses these to shape its behavior; you can
        also author them as markdown files under <code>~/.nimblebrain/skills/</code> (org),{" "}
        <code>workspaces/&lt;wsId&gt;/skills/</code>, or <code>users/&lt;userId&gt;/skills/</code>.
      </p>

      <Filters
        scope={scopeFilter}
        status={statusFilter}
        onScopeChange={setScopeFilter}
        onStatusChange={setStatusFilter}
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
          <SkillList grouped={grouped} selectedId={selectedId} onSelect={handleSelect} />
          {creating ? (
            <CreateForm
              pending={actionPending}
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

interface CreateInput {
  scope: WritableScope;
  name: string;
  manifest: Record<string, unknown>;
  body: string;
}

// ── List view ────────────────────────────────────────────────────────────

interface GroupedSkills {
  scope: Scope;
  skills: ListedSkill[];
}

function groupByScope(skills: ListedSkill[]): GroupedSkills[] {
  const order: Scope[] = ["user", "workspace", "org", "bundle"];
  const map = new Map<Scope, ListedSkill[]>();
  for (const s of skills) {
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

function SkillList({
  grouped,
  selectedId,
  onSelect,
}: {
  grouped: GroupedSkills[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      {grouped.map((group) => (
        <section key={group.scope} className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-1">
            {SCOPE_LABEL[group.scope]}{" "}
            <span className="text-muted-foreground/60 font-normal">({group.skills.length})</span>
          </h3>
          <div className="grid gap-1">
            {group.skills.map((s) => (
              <SkillRow
                key={s.id}
                skill={s}
                selected={s.id === selectedId}
                onSelect={() => onSelect(s.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SkillRow({
  skill,
  selected,
  onSelect,
}: {
  skill: ListedSkill;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Card
      className={cn(
        "cursor-pointer transition-colors",
        selected ? "ring-1 ring-primary border-primary/40" : "hover:bg-muted/40",
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
  if (mode === "edit") {
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
}: { detail: ReadSkill } & Pick<
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
            {!isBundle && (
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
          </div>
          {m.description && <p className="text-xs text-muted-foreground">{m.description}</p>}
          {isBundle && (
            <p className="text-[11px] text-muted-foreground italic">
              Bundle (Layer 1) skills are vendored — edit them through the bundle's own settings.
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
  loadingStrategy: "" | "always" | "tool_affined" | "retrieval" | "explicit";
  appliesToTools: string; // comma-separated
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
    loadingStrategy: (m.loadingStrategy as EditorFormState["loadingStrategy"]) ?? "",
    appliesToTools: (m.appliesToTools ?? []).join(", "),
    status: (m.status as Status) ?? "active",
    body: detail.content,
  });

  const handleSave = () => {
    const patch: Record<string, unknown> = {
      description: form.description,
      type: form.type,
      status: form.status,
    };
    const priorityNum = Number.parseInt(form.priority, 10);
    if (Number.isFinite(priorityNum)) patch.priority = priorityNum;
    if (form.loadingStrategy) patch["loading-strategy"] = form.loadingStrategy;
    const tools = form.appliesToTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    patch["applies-to-tools"] = tools;
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
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (input: CreateInput) => void;
}) {
  const [scope, setScope] = useState<WritableScope>("workspace");
  const [name, setName] = useState("");
  const [form, setForm] = useState<EditorFormState>({
    description: "",
    type: "skill",
    priority: "50",
    loadingStrategy: "",
    appliesToTools: "",
    status: "active",
    body: "",
  });

  const handleSubmit = () => {
    if (!name.trim()) return;
    const manifest: Record<string, unknown> = {
      description: form.description,
      type: form.type,
      status: form.status,
    };
    const priorityNum = Number.parseInt(form.priority, 10);
    if (Number.isFinite(priorityNum)) manifest.priority = priorityNum;
    if (form.loadingStrategy) manifest["loading-strategy"] = form.loadingStrategy;
    const tools = form.appliesToTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tools.length > 0) manifest["applies-to-tools"] = tools;
    onSubmit({ scope, name: name.trim(), manifest, body: form.body });
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

        <div className="grid grid-cols-2 gap-3">
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
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="skill-loading">
            Loading strategy
          </label>
          <select
            id="skill-loading"
            value={form.loadingStrategy}
            onChange={(e) =>
              setForm({
                ...form,
                loadingStrategy: e.target.value as EditorFormState["loadingStrategy"],
              })
            }
            className={selectClass}
          >
            <option value="">(default)</option>
            <option value="always">always</option>
            <option value="tool_affined">tool_affined</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor="skill-tools">
            Tool affinity (comma-separated globs)
          </label>
          <Input
            id="skill-tools"
            value={form.appliesToTools}
            onChange={(e) => setForm({ ...form, appliesToTools: e.target.value })}
            placeholder="synapse-collateral__*, synapse-crm__*"
          />
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
}: {
  scope: Scope | "all";
  status: Status | "all";
  onScopeChange: (s: Scope | "all") => void;
  onStatusChange: (s: Status | "all") => void;
}) {
  const selectClass =
    "rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring";
  return (
    <div className="flex flex-wrap items-center gap-2">
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
