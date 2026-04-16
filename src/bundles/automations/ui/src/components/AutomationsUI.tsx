import { useCallTool, useDataSync } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useState } from "react";
import { ClockIcon, PlusIcon } from "../icons.tsx";
import type { AutomationRun, AutomationSummary } from "../types.ts";
import { asDict } from "../utils.ts";
import { AutomationCard } from "./AutomationCard.tsx";
import { AutomationDetailView } from "./AutomationDetailView.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { CreateAutomationForm, TEMPLATES } from "./CreateAutomationForm.tsx";
import { RunRow } from "./RunRow.tsx";
import { SkeletonCards, SkeletonRows } from "./Skeleton.tsx";

export function AutomationsUI() {
  // Tool hooks
  const listTool = useCallTool<string>("list");
  const runsTool = useCallTool<string>("runs");
  const runNowTool = useCallTool<string>("run");
  const updateTool = useCallTool<string>("update");
  const deleteTool = useCallTool<string>("delete");
  const cancelTool = useCallTool<string>("cancel");

  // State
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<Record<string, string>>({});
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
      await updateTool.call({ name, enabled: !currentlyEnabled });
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
    try {
      await updateTool.call({ name, ...fields });
    } catch {
      // silent
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

  // Create form
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

  // Detail view
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

  // List view
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

      <div className="content">
        {error && <div className="error-banner">{error}</div>}

        <div className="section-header">Automations</div>

        {loading ? (
          <SkeletonCards count={3} />
        ) : automations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <ClockIcon />
            </div>
            <div className="empty-state-title">No automations yet</div>
            <div className="empty-state-desc">
              Create your first automation to run tasks on a schedule.
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 16,
                justifyContent: "center",
              }}
            >
              {TEMPLATES.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="btn"
                  style={{
                    textAlign: "left",
                    padding: "8px 12px",
                    ...(t.id === "custom" ? { borderStyle: "dashed" } : {}),
                  }}
                  onClick={() => {
                    setCreateTemplate(t);
                    setShowCreateForm(true);
                  }}
                >
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: "var(--color-text-secondary, #737373)" }}>
                    {t.description}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="auto-list">
            {automations.map((a) => (
              <AutomationCard
                key={a.id}
                automation={a}
                actionInProgress={actionInProgress[a.name]}
                onClick={() => setSelectedAutomation(a.name)}
                onRunNow={() => handleRunNow(a.name)}
                onToggle={() => handleToggle(a.name, a.enabled)}
                onDelete={() => handleDelete(a.name)}
                onCancel={() => handleCancel(a.name)}
              />
            ))}
          </div>
        )}

        <div className="section-header" style={{ marginTop: 24 }}>
          Recent Runs
        </div>

        {runsLoading && runs.length === 0 ? (
          <SkeletonRows count={4} />
        ) : runs.length === 0 ? (
          <div className="empty-state" style={{ padding: "32px 24px" }}>
            <div className="empty-state-desc">No run history yet.</div>
          </div>
        ) : (
          <div className="run-list">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} showName />
            ))}
          </div>
        )}
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
