import { Lightbulb } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { callTool } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
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
type Scope = "platform" | "workspace" | "user" | "bundle";
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
  platform: "border-blue-300/30 text-blue-400",
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

function Inner() {
  const [skills, setSkills] = useState<ListedSkill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReadSkill | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<Scope | "all">("all");
  const [statusFilter, setStatusFilter] = useState<Status | "all">("active");

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
    }
  }, [skills, selectedId]);

  // Fetch the detail body whenever selection changes.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    (async () => {
      try {
        const res = await callTool("skills", "read", { id: selectedId });
        const data = parseToolResponse<ReadSkill>(res);
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to read skill.";
          setError(msg);
          setDetail(null);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const grouped = useMemo(() => groupByScope(skills), [skills]);

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <Lightbulb className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Skills</h2>
      </header>
      <p className="text-xs text-muted-foreground">
        Layer 3 cross-bundle agent orchestration content (voice, workflow, personal, tool routing)
        plus Layer 1 vendored bundle skills. The agent uses these to shape its behavior; you can
        author them as markdown files under <code>~/.nimblebrain/skills/</code> (platform),{" "}
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
          <CardContent className="py-6 text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && skills.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No skills match the current filters. Drop a markdown file under one of the skills
              directories above to get started.
            </p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && skills.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <SkillList grouped={grouped} selectedId={selectedId} onSelect={setSelectedId} />
          <SkillDetail
            selectedId={selectedId}
            detail={detail}
            loading={detailLoading}
            placeholder={skills.length > 0}
          />
        </div>
      )}
    </div>
  );
}

// ── List view ────────────────────────────────────────────────────────────

interface GroupedSkills {
  scope: Scope;
  skills: ListedSkill[];
}

function groupByScope(skills: ListedSkill[]): GroupedSkills[] {
  const order: Scope[] = ["user", "workspace", "platform", "bundle"];
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
  platform: "Platform",
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

function SkillDetail({
  selectedId,
  detail,
  loading,
  placeholder,
}: {
  selectedId: string | null;
  detail: ReadSkill | null;
  loading: boolean;
  placeholder: boolean;
}) {
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
  const m = detail.metadata;
  return (
    <Card className="lg:sticky lg:top-4 self-start">
      <CardContent className="py-4 px-4 space-y-4">
        <header className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold">{m.name}</h3>
            <Badge variant="outline" className={cn("text-[10px]", SCOPE_BADGE[detail.scope])}>
              L{detail.layer} · {detail.scope}
            </Badge>
            {m.status && (
              <Badge
                variant="outline"
                className={cn("text-[10px]", STATUS_BADGE[m.status as Status])}
              >
                {m.status}
              </Badge>
            )}
          </div>
          {m.description && <p className="text-xs text-muted-foreground">{m.description}</p>}
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
  { value: "platform", label: "Platform" },
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
