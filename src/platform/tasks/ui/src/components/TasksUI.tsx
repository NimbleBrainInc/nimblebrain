import { hostSupports } from "@nimblebrain/synapse";
import { useApp, useDataSync } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useState } from "react";
import { ClockIcon, PlusIcon } from "../icons.tsx";
import type { TaskRun, TaskSummary } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict } from "../utils.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { CreateTaskForm, TEMPLATES } from "./CreateTaskForm.tsx";
import { RailRunItem, RailTaskItem } from "./RailItem.tsx";
import { ReaderPane } from "./ReaderPane.tsx";
import { SkeletonCards, SkeletonRows } from "./Skeleton.tsx";
import { TaskDetailView } from "./TaskDetailView.tsx";

/**
 * Read every task by following `nextCursor` to the end.
 *
 * Accumulated into a Map keyed by id rather than appended: the handler
 * re-serves the first page when a cursor names a record that no longer exists
 * (deleted between fetches). That is the right server behaviour — repeat work
 * rather than skip it — but a walk that pushes unconditionally would duplicate
 * rows, inflate the count badge that reads off them, and collide React keys.
 *
 * `exhausted` is false when the walk stopped on the page budget with a cursor
 * still in hand, so the caller can say so instead of rendering a short list.
 */
async function fetchAllTasks(
  call: (args: Record<string, unknown>) => Promise<{ data?: unknown }>,
): Promise<{ items: TaskSummary[]; exhausted: boolean }> {
  // 500 is TASKS_LIST_MAX_LIMIT; a literal because this app's Vite
  // tsconfig scopes to its own src and cannot import src/limits.ts.
  const PAGE = 500;
  const MAX_PAGES = 50;
  const byId = new Map<string, TaskSummary>();
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const result = await call(cursor ? { cursor, limit: PAGE } : { limit: PAGE });
    const data = asDict(result.data);
    for (const a of (data.tasks as TaskSummary[]) || []) byId.set(a.id, a);
    const next = data.nextCursor as string | null | undefined;
    if (!next) return { items: [...byId.values()], exhausted: true };
    cursor = next;
  }
  return { items: [...byId.values()], exhausted: false };
}

export function TasksUI() {
  const app = useApp();
  // The host draws this view's title in its own chrome when it declares
  // `ai.nimblebrain/location`, so the view leaves its own out rather than say it
  // twice. A host without it (any other MCP Apps host) gets the view's title.
  const hostShowsTitle = hostSupports(app, "location");
  // Tool hooks
  const listTool = useTool<string>("list");
  const runsTool = useTool<string>("runs");
  const runNowTool = useTool<string>("run");
  const updateTool = useTool<string>("update");
  const deleteTool = useTool<string>("delete");
  const cancelTool = useTool<string>("cancel");

  // Data state
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
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
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createTemplate, setCreateTemplate] = useState<(typeof TEMPLATES)[0] | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: listTool.call is stable, adding it would cause infinite re-renders
  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The list tool caps a page to protect a model's context window; this
      // panel is a browser consumer with no such limit, so it reads to the end.
      const { items, exhausted } = await fetchAllTasks(listTool.call);
      setTasks(items);
      // Rendering a short list under a count badge that agrees with it is the
      // failure this panel's paging exists to avoid — so say so instead.
      if (!exhausted) {
        setError(
          `Showing the first ${items.length} tasks; more exist than this panel loads in one pass.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
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
      setRuns((data.runs as TaskRun[]) || []);
    } catch {
      // silent
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const loadAll = useCallback(() => {
    loadTasks();
    loadRuns();
  }, [loadTasks, loadRuns]);

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
      if (selectedTask === name) setSelectedTask(null);
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
      <CreateTaskForm
        onCreated={(name) => {
          setShowCreateForm(false);
          setCreateTemplate(null);
          setSelectedTask(name);
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

  // Task config view (full-panel)
  if (selectedTask) {
    const summary = tasks.find((a) => a.name === selectedTask);
    return (
      <>
        <TaskDetailView
          taskName={selectedTask}
          onBack={() => setSelectedTask(null)}
          actionInProgress={actionInProgress[selectedTask]}
          onRunNow={() => handleRunNow(selectedTask)}
          onToggle={() => handleToggle(selectedTask, summary?.enabled ?? true)}
          onDelete={() => handleDelete(selectedTask)}
          onCancel={() => handleCancel(selectedTask)}
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
  const selectedRunTask = selectedRun ? tasks.find((a) => a.id === selectedRun.taskId) : undefined;
  // Mobile pane visibility is driven by explicit navigation, not selection.
  // See the comment on `userOpenedReader` above.
  const paneShow: "rail" | "reader" = userOpenedReader ? "reader" : "rail";
  const taskNameById = new Map(tasks.map((a) => [a.id, a.name]));

  return (
    <div className="app">
      <div className="header">
        <div className="header-top">
          <div>
            {!hostShowsTitle && <div className="header-title">Tasks</div>}
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
          <RailSection label="Tasks" count={tasks.length} />
          <TasksList
            loading={loading}
            tasks={tasks}
            selectedTask={selectedTask}
            onSelectTask={(name) => setSelectedTask(name)}
            onPickTemplate={pickTemplate}
          />

          <RailSection label="Recent Runs" count={runs.length} />
          <RunsList
            runs={runs}
            runsLoading={runsLoading}
            selectedRunId={selectedRunId}
            taskNameById={taskNameById}
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
          tasks={tasks}
          selectedRun={selectedRun}
          selectedRunTask={selectedRunTask}
          onRerun={handleRunNow}
          onOpenConfig={(name) => setSelectedTask(name)}
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
            color: "var(--color-text-secondary)",
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

/** Rail body for tasks — skeletons while loading, a template picker when empty, else the list. */
function TasksList({
  loading,
  tasks,
  selectedTask,
  onSelectTask,
  onPickTemplate,
}: {
  loading: boolean;
  tasks: TaskSummary[];
  selectedTask: string | null;
  onSelectTask: (name: string) => void;
  onPickTemplate: (t: (typeof TEMPLATES)[0]) => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: "4px 16px" }}>
        <SkeletonCards count={2} />
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className="rail-empty">
        No tasks yet. Start from a template:
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
      {tasks.map((a) => (
        <RailTaskItem
          key={a.id}
          task={a}
          active={selectedTask === a.name}
          onClick={() => onSelectTask(a.name)}
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
  taskNameById,
  onSelectRun,
}: {
  runs: TaskRun[];
  runsLoading: boolean;
  selectedRunId: string | null;
  taskNameById: Map<string, string>;
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
          taskName={taskNameById.get(run.taskId)}
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
  tasks,
  selectedRun,
  selectedRunTask,
  onRerun,
  onOpenConfig,
  onBack,
}: {
  runs: TaskRun[];
  runsLoading: boolean;
  loading: boolean;
  tasks: TaskSummary[];
  selectedRun: TaskRun | null;
  selectedRunTask: TaskSummary | undefined;
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
            {tasks.length === 0
              ? "Create a task from a template in the left panel to get started."
              : "Your tasks have not run yet. Pick one and Run now, or wait for the schedule."}
          </div>
        </div>
      </div>
    );
  }
  return (
    <ReaderPane
      run={selectedRun}
      task={selectedRunTask}
      onRerun={onRerun}
      onOpenConfig={onOpenConfig}
      onBack={onBack}
    />
  );
}
