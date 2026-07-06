import { useCallTool, useDataSync } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useState } from "react";
import { ClockIcon, PlusIcon } from "../icons.tsx";
import type { AutomationRun, AutomationSummary } from "../types.ts";
import { asDict } from "../utils.ts";
import { AutomationDetailView } from "./AutomationDetailView.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { CreateAutomationForm, TEMPLATES } from "./CreateAutomationForm.tsx";
import { RailAutomationItem, RailRunItem } from "./RailItem.tsx";
import { ReaderPane } from "./ReaderPane.tsx";
import { SkeletonCards, SkeletonRows } from "./Skeleton.tsx";

export function AutomationsUI() {
  // Tool hooks
  const listTool = useCallTool<string>("list");
  const runsTool = useCallTool<string>("runs");
  const runNowTool = useCallTool<string>("run");
  const updateTool = useCallTool<string>("update");
  const deleteTool = useCallTool<string>("delete");
  const cancelTool = useCallTool<string>("cancel");

  // Data state
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<Record<string, string>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // `userOpenedReader` only flips on explicit run click / back. On desktop
  // both panes render regardless (no media query applies), so this only
  // matters at <720px where the rail and reader stack and one is hidden.
  // Without this, the auto-select of the most recent run would push the
  // user straight into the reader on first load and hide the lists.
  const [userOpenedReader, setUserOpenedReader] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createTemplate, setCreateTemplate] = useState<(typeof TEMPLATES)[0] | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: listTool.call is stable, adding it would cause infinite re-renders
  const loadAutomations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listTool.call({});
      const data = asDict(result.data);
      setAutomations((data.automations as AutomationSummary[]) || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load automations");
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runsTool.call is stable, adding it would cause infinite re-renders
  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const result = await runsTool.call({ limit: 20 });
      const data = asDict(result.data);
      setRuns((data.runs as AutomationRun[]) || []);
    } catch {
      // silent
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const loadAll = useCallback(() => {
    loadAutomations();
    loadRuns();
  }, [loadAutomations, loadRuns]);

  // Initial load
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Auto-refresh when agent mutates data
  useDataSync(() => {
    loadAll();
  });

  // Auto-select the most recent run when one isn't selected (first load,
  // or after the previously selected run was pruned from the 20-deep window).
  useEffect(() => {
    if (runs.length === 0) {
      if (selectedRunId) setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !runs.some((r) => r.id === selectedRunId)) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  // Actions
  async function handleRunNow(name: string) {
    setActionInProgress((prev) => ({ ...prev, [name]: "running" }));
    try {
      await runNowTool.call({ name });
    } catch {
      // silent
    } finally {
      setActionInProgress((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      loadAll();
    }
  }

  async function handleToggle(name: string, currentlyEnabled: boolean) {
    const action = currentlyEnabled ? "pausing" : "resuming";
    setActionInProgress((prev) => ({ ...prev, [name]: action }));
    try {
      await updateTool.call({ name, manifest: { enabled: !currentlyEnabled } });
    } catch {
      // silent
    } finally {
      setActionInProgress((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      loadAll();
    }
  }

  async function handleCancel(name: string) {
    setActionInProgress((prev) => ({ ...prev, [name]: "cancelling" }));
    try {
      await cancelTool.call({ name });
    } catch {
      // silent
    } finally {
      setActionInProgress((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      loadAll();
    }
  }

  async function handleUpdate(name: string, fields: Record<string, unknown>) {
    // Server's update tool expects { name, manifest?, body? }. The detail
    // view's saveField() passes a flat { [field]: value } — split it: the
    // prompt goes into `body`, everything else into `manifest`.
    const args: Record<string, unknown> = { name };
    const manifest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === "prompt") {
        args.body = v;
      } else if (k !== "name") {
        manifest[k] = v;
      }
    }
    if (Object.keys(manifest).length > 0) args.manifest = manifest;
    // Refresh the list either way, but let the error propagate so the caller
    // (e.g. the detail view's saveField) can surface it. Swallowing it here
    // made a rejected update — like an out-of-range maxIterations — look like
    // a silent no-op: the field just snapped back to its old value.
    try {
      await updateTool.call(args);
    } finally {
      loadAll();
    }
  }

  function handleDelete(name: string) {
    setConfirmDelete(name);
  }

  async function confirmDeleteYes() {
    const name = confirmDelete;
    setConfirmDelete(null);
    if (!name) return;

    setActionInProgress((prev) => ({ ...prev, [name]: "deleting" }));
    try {
      await deleteTool.call({ name });
    } catch {
      // silent
    } finally {
      setActionInProgress((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      if (selectedAutomation === name) setSelectedAutomation(null);
      loadAll();
    }
  }

  function handleCreate() {
    setShowCreateForm(true);
  }

  function pickTemplate(t: (typeof TEMPLATES)[0]) {
    setCreateTemplate(t);
    setShowCreateForm(true);
  }

  // Create form (full-panel)
  if (showCreateForm) {
    return (
      <CreateAutomationForm
        onCreated={(name) => {
          setShowCreateForm(false);
          setCreateTemplate(null);
          setSelectedAutomation(name);
          loadAll();
        }}
        onCancel={() => {
          setShowCreateForm(false);
          setCreateTemplate(null);
        }}
        initialTemplate={createTemplate}
      />
    );
  }

  // Automation config view (full-panel)
  if (selectedAutomation) {
    const summary = automations.find((a) => a.name === selectedAutomation);
    return (
      <>
        <AutomationDetailView
          automationName={selectedAutomation}
          onBack={() => setSelectedAutomation(null)}
          actionInProgress={actionInProgress[selectedAutomation]}
          onRunNow={() => handleRunNow(selectedAutomation)}
          onToggle={() => handleToggle(selectedAutomation, summary?.enabled ?? true)}
          onDelete={() => handleDelete(selectedAutomation)}
          onCancel={() => handleCancel(selectedAutomation)}
          onUpdate={handleUpdate}
        />
        {confirmDelete && (
          <ConfirmDialog
            name={confirmDelete}
            onConfirm={confirmDeleteYes}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </>
    );
  }

  // Two-pane reader (default)
  const selectedRun = runs.find((r) => r.id === selectedRunId) || null;
  const selectedRunAutomation = selectedRun
    ? automations.find((a) => a.id === selectedRun.automationId)
    : undefined;
  // Mobile pane visibility is driven by explicit navigation, not selection.
  // See the comment on `userOpenedReader` above.
  const paneShow: "rail" | "reader" = userOpenedReader ? "reader" : "rail";
  const automationNameById = new Map(automations.map((a) => [a.id, a.name]));

  return (
    <div className="app">
      <div className="header">
        <div className="header-top">
          <div>
            <div className="header-title">Automations</div>
            <div className="header-lede">Scheduled tasks that run on autopilot</div>
          </div>
          <button type="button" className="create-btn" onClick={handleCreate}>
            <PlusIcon />
            Create
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />

      <div className="two-pane" data-show={paneShow}>
        <aside className="rail">
          <RailSection label="Automations" count={automations.length} />
          <AutomationsList
            loading={loading}
            automations={automations}
            selectedAutomation={selectedAutomation}
            onSelectAutomation={(name) => setSelectedAutomation(name)}
            onPickTemplate={pickTemplate}
          />

          <RailSection label="Recent Runs" count={runs.length} />
          <RunsList
            runs={runs}
            runsLoading={runsLoading}
            selectedRunId={selectedRunId}
            automationNameById={automationNameById}
            onSelectRun={(id) => {
              setSelectedRunId(id);
              setUserOpenedReader(true);
            }}
          />
        </aside>

        <ReaderArea
          runs={runs}
          runsLoading={runsLoading}
          loading={loading}
          automations={automations}
          selectedRun={selectedRun}
          selectedRunAutomation={selectedRunAutomation}
          onRerun={handleRunNow}
          onOpenConfig={(name) => setSelectedAutomation(name)}
          onBack={() => setUserOpenedReader(false)}
        />
      </div>

      {confirmDelete && (
        <ConfirmDialog
          name={confirmDelete}
          onConfirm={confirmDeleteYes}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/** Padded error banner shown above the two-pane layout; renders nothing when there is no error. */
function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div style={{ padding: "0 20px" }}>
      <div className="error-banner">{error}</div>
    </div>
  );
}

/** Rail section header with an optional right-aligned count badge (hidden when count is zero). */
function RailSection({ label, count }: { label: string; count: number }) {
  return (
    <div className="rail-section">
      <span>{label}</span>
      {count > 0 && (
        <span
          style={{
            fontSize: 11,
            color: "var(--color-text-secondary, #737373)",
            textTransform: "none",
            letterSpacing: 0,
            fontWeight: 400,
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

/** Rail body for automations — skeletons while loading, a template picker when empty, else the list. */
function AutomationsList({
  loading,
  automations,
  selectedAutomation,
  onSelectAutomation,
  onPickTemplate,
}: {
  loading: boolean;
  automations: AutomationSummary[];
  selectedAutomation: string | null;
  onSelectAutomation: (name: string) => void;
  onPickTemplate: (t: (typeof TEMPLATES)[0]) => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: "4px 16px" }}>
        <SkeletonCards count={2} />
      </div>
    );
  }
  if (automations.length === 0) {
    return (
      <div className="rail-empty">
        No automations yet. Start from a template:
        <div className="template-grid" style={{ marginTop: 8 }}>
          {TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`template-card${t.id === "custom" ? " dashed" : ""}`}
              onClick={() => onPickTemplate(t)}
            >
              <span className="template-card-name">{t.name}</span>
              <span className="template-card-desc">{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <>
      {automations.map((a) => (
        <RailAutomationItem
          key={a.id}
          automation={a}
          active={selectedAutomation === a.name}
          onClick={() => onSelectAutomation(a.name)}
        />
      ))}
    </>
  );
}

/** Rail body for recent runs — skeletons on first load, an empty note, else the run list. */
function RunsList({
  runs,
  runsLoading,
  selectedRunId,
  automationNameById,
  onSelectRun,
}: {
  runs: AutomationRun[];
  runsLoading: boolean;
  selectedRunId: string | null;
  automationNameById: Map<string, string>;
  onSelectRun: (id: string) => void;
}) {
  if (runsLoading && runs.length === 0) {
    return (
      <div style={{ padding: "4px 16px" }}>
        <SkeletonRows count={3} />
      </div>
    );
  }
  if (runs.length === 0) {
    return <div className="rail-empty">No runs yet.</div>;
  }
  return (
    <>
      {runs.map((run) => (
        <RailRunItem
          key={run.id}
          run={run}
          automationName={automationNameById.get(run.automationId)}
          active={selectedRunId === run.id}
          onClick={() => onSelectRun(run.id)}
        />
      ))}
    </>
  );
}

/** Right pane — a "no runs yet" placeholder until runs exist, otherwise the run reader. */
function ReaderArea({
  runs,
  runsLoading,
  loading,
  automations,
  selectedRun,
  selectedRunAutomation,
  onRerun,
  onOpenConfig,
  onBack,
}: {
  runs: AutomationRun[];
  runsLoading: boolean;
  loading: boolean;
  automations: AutomationSummary[];
  selectedRun: AutomationRun | null;
  selectedRunAutomation: AutomationSummary | undefined;
  onRerun: (name: string) => void;
  onOpenConfig: (name: string) => void;
  onBack: () => void;
}) {
  if (runs.length === 0 && !runsLoading && !loading) {
    return (
      <div className="reader">
        <div className="reader-empty">
          <ClockIcon />
          <div className="reader-empty-title" style={{ marginTop: 12 }}>
            No runs yet
          </div>
          <div className="reader-empty-desc">
            {automations.length === 0
              ? "Create an automation from a template in the left panel to get started."
              : "Your automations haven't run yet. Pick one and Run now, or wait for the schedule."}
          </div>
        </div>
      </div>
    );
  }
  return (
    <ReaderPane
      run={selectedRun}
      automation={selectedRunAutomation}
      onRerun={onRerun}
      onOpenConfig={onOpenConfig}
      onBack={onBack}
    />
  );
}
