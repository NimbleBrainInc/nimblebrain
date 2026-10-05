import { useDataSync, useTrail } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlusIcon } from "../icons.tsx";
import type { TaskSummary, TaskWarning } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, toolErrorText } from "../utils.ts";
import { ActivityView } from "./ActivityView.tsx";
import { BatchDialog } from "./BatchDialog.tsx";
import { BatchScreen } from "./BatchPane.tsx";
import { HostTrailContext, Tabs } from "./Chrome.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ResultScreen } from "./ResultView.tsx";
import { RunDialog, type RunStarted, runStartedOf } from "./RunDialog.tsx";
import { type SavedActions, SavedView } from "./SavedView.tsx";
import { TaskEditor } from "./TaskEditor.tsx";
import { TaskPage, type TaskPageActions } from "./TaskPage.tsx";
import { type Screen, trailFor, VIEWS, type View } from "./trail.ts";
import { UpcomingView } from "./UpcomingView.tsx";

export type { View } from "./trail.ts";

/**
 * Read every task by following `nextCursor` to the end.
 *
 * Accumulated into a Map keyed by id rather than appended: the handler
 * re-serves the first page when a cursor names a record that no longer exists
 * (deleted between fetches). That is the right server behaviour — repeat work
 * rather than skip it — but a walk that pushes unconditionally would duplicate
 * rows and collide React keys.
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

/** The view switcher. */
export function ViewTabs({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return <Tabs tabs={VIEWS} value={view} onChange={onChange} label="Tasks views" idPrefix="view" />;
}

/** A task the panel acts on: its id and name, and its input schema when the list has it. */
type TaskRef = { id: string; name: string; inputSchema?: Record<string, unknown> };

export function TasksUI() {
  const listTool = useTool<string>("list");
  const runTool = useTool<string>("run");
  const updateTool = useTool<string>("update");
  const deleteTool = useTool<string>("delete");

  const [view, setView] = useState<View>("saved");
  const [stack, setStack] = useState<Screen[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [runDialog, setRunDialog] = useState<TaskRef | null>(null);
  const [batchDialog, setBatchDialog] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TaskRef | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: listTool.call is stable
  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      // The list tool caps a page to protect a model's context window; this
      // panel is a browser consumer with no such limit, so it reads to the end.
      const { items, exhausted } = await fetchAllTasks(listTool.call);
      items.sort((a, b) => a.name.localeCompare(b.name));
      setTasks(items);
      setError(
        exhausted
          ? null
          : `Showing the first ${items.length} tasks; more exist than this panel loads in one pass.`,
      );
    } catch (err) {
      setError(toolErrorText(err, "The tasks could not be read."));
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void loadTasks();
    setRefreshKey((k) => k + 1);
  }, [loadTasks]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // Re-read when the server announces a change (the agent, a schedule, another tab).
  useDataSync(() => refresh());

  const nameOf = useCallback((taskId: string) => tasks.find((t) => t.id === taskId)?.name, [tasks]);
  const trail = useMemo(() => trailFor(view, stack, nameOf), [view, stack, nameOf]);
  const hostShowsTrail = useTrail(
    trail.map(({ id, label }) => ({ id, label })),
    (id) => {
      const step = trail.find((s) => s.id === id);
      if (!step) return;
      if (step.view) setView(step.view);
      setStack(step.stack);
    },
  );

  const top = stack[stack.length - 1];
  const push = (s: Screen) => setStack((prev) => [...prev, s]);
  const pop = () => {
    setNotice(null);
    setStack((prev) => prev.slice(0, -1));
  };

  function mark(id: string, what: string | null) {
    setBusy((prev) => {
      const next = { ...prev };
      if (what) next[id] = what;
      else delete next[id];
      return next;
    });
  }

  function openStarted(started: RunStarted) {
    if (started.kind === "finished") {
      push({ kind: "result", runId: started.run.id, taskId: started.run.taskId, run: started.run });
    } else {
      setNotice(started.note);
      push({ kind: "result", runId: started.runId, taskId: started.taskId });
    }
  }

  /** Run now: straight away, or through the input dialog when the task takes input. */
  async function runNow(task: TaskRef, input?: unknown) {
    const schema = task.inputSchema ?? tasks.find((t) => t.id === task.id)?.inputSchema;
    if (input === undefined && schema) {
      setRunDialog({ ...task, inputSchema: schema });
      return;
    }
    mark(task.id, "running");
    setNotice(null);
    try {
      const res = await runTool.call({
        taskId: task.id,
        ...(input !== undefined ? { input } : {}),
      });
      const started = runStartedOf(asDict(res.data));
      if (started) openStarted(started);
    } catch (err) {
      setNotice(toolErrorText(err, "The run did not start."));
    } finally {
      mark(task.id, null);
      refresh();
    }
  }

  async function setEnabled(task: TaskRef, enabled: boolean) {
    mark(task.id, enabled ? "resuming" : "pausing");
    try {
      await updateTool.call({ name: task.id, manifest: { enabled } });
    } catch (err) {
      setNotice(toolErrorText(err));
      throw err;
    } finally {
      mark(task.id, null);
      refresh();
    }
  }

  async function remove(task: TaskRef) {
    setConfirmDelete(null);
    mark(task.id, "deleting");
    try {
      await deleteTool.call({ name: task.id });
      setStack((prev) => prev.filter((s) => !(s.kind === "task" && s.taskName === task.name)));
    } catch (err) {
      setNotice(toolErrorText(err));
    } finally {
      mark(task.id, null);
      refresh();
    }
  }

  const savedActions: SavedActions = {
    onOpen: (t) => push({ kind: "task", taskName: t.name }),
    onRunNow: (t) => void runNow(t),
    onRunList: (t) => setBatchDialog(t.name),
    onEdit: (t) => push({ kind: "editor", taskName: t.name }),
    onDuplicate: (t) => push({ kind: "editor", copyOf: t.name }),
    onToggle: (t) => void setEnabled(t, !t.enabled).catch(() => {}),
    onDelete: (t) => setConfirmDelete(t),
    onOpenRun: (t, runId) => push({ kind: "result", runId, taskId: t.id }),
    onCreate: (template) => push({ kind: "editor", template: template ?? null }),
  };

  const taskActions: TaskPageActions = {
    onRunNow: (d) => void runNow({ id: d.id, name: d.name, inputSchema: d.inputSchema }),
    onRunList: (d) => setBatchDialog(d.name),
    onEdit: (d) => push({ kind: "editor", taskName: d.name }),
    onDuplicate: (d) => push({ kind: "editor", copyOf: d.name }),
    onDelete: (d) => setConfirmDelete({ id: d.id, name: d.name }),
    onSetEnabled: (d, enabled) => setEnabled(d, enabled),
    onOpenRun: (run) => push({ kind: "result", runId: run.id, taskId: run.taskId, run }),
    onOpenBatch: (batch) => push({ kind: "batch", batchId: batch.id, batch }),
  };

  const dialogs = (
    <>
      {runDialog && (
        <RunDialog
          taskId={runDialog.id}
          taskName={runDialog.name}
          inputSchema={runDialog.inputSchema}
          onClose={() => setRunDialog(null)}
          onStarted={(started) => {
            setRunDialog(null);
            openStarted(started);
            refresh();
          }}
        />
      )}
      {batchDialog && (
        <BatchDialog
          taskName={batchDialog}
          onClose={() => setBatchDialog(null)}
          onCreated={(batch) => {
            setBatchDialog(null);
            push({ kind: "batch", batchId: batch.id, batch });
            refresh();
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          name={confirmDelete.name}
          onConfirm={() => void remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}{" "}
          <button type="button" className="link-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );

  if (top) {
    return (
      <HostTrailContext.Provider value={hostShowsTrail}>
        <ScreenRoute
          screen={top}
          tasks={tasks}
          busy={busy}
          refreshKey={refreshKey}
          taskActions={taskActions}
          onBack={pop}
          onPush={push}
          onReplaceTop={(s) => setStack((prev) => [...prev.slice(0, -1), ...(s ? [s] : [])])}
          onRerun={(task, input) => void runNow(task, input)}
          onSaved={(warnings) => {
            setNotice(warnings.length > 0 ? warnings.map((w) => w.message).join(" ") : null);
            refresh();
          }}
        />
        {dialogs}
      </HostTrailContext.Provider>
    );
  }

  return (
    <HostTrailContext.Provider value={hostShowsTrail}>
      <div className="app">
        <header className="header">
          {!hostShowsTrail && <h1 className="page-title">Tasks</h1>}
          <div className="header-row">
            <ViewTabs view={view} onChange={setView} />
            <button type="button" className="create-btn" onClick={() => push({ kind: "editor" })}>
              <PlusIcon />
              New task
            </button>
          </div>
        </header>
        <main
          className="content"
          id="view-panel"
          role="tabpanel"
          aria-labelledby={`view-tab-${view}`}
        >
          {view === "saved" && (
            <SavedView
              tasks={tasks}
              loading={loading}
              error={error}
              busy={busy}
              refreshKey={refreshKey}
              actions={savedActions}
            />
          )}
          {view === "upcoming" && (
            <UpcomingView
              refreshKey={refreshKey}
              onOpenRun={(r) =>
                r.runId && push({ kind: "result", runId: r.runId, taskId: r.taskId })
              }
              onOpenTask={(name) => push({ kind: "task", taskName: name })}
            />
          )}
          {view === "activity" && (
            <ActivityView
              tasks={tasks}
              refreshKey={refreshKey}
              onOpenRun={(run) => push({ kind: "result", runId: run.id, taskId: run.taskId, run })}
              onOpenBatch={(batch) => push({ kind: "batch", batchId: batch.id, batch })}
            />
          )}
        </main>
        {dialogs}
      </div>
    </HostTrailContext.Provider>
  );
}

/** The screen on top of the stack. */
function ScreenRoute({
  screen,
  tasks,
  busy,
  refreshKey,
  taskActions,
  onBack,
  onPush,
  onReplaceTop,
  onRerun,
  onSaved,
}: {
  screen: Screen;
  tasks: TaskSummary[];
  busy: Record<string, string>;
  refreshKey: number;
  taskActions: TaskPageActions;
  onBack: () => void;
  onPush: (s: Screen) => void;
  onReplaceTop: (s: Screen | null) => void;
  onRerun: (task: TaskRef, input: unknown) => void;
  onSaved: (warnings: TaskWarning[]) => void;
}) {
  const nameOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.name;
  const openRun = (runId: string, taskId?: string) => onPush({ kind: "result", runId, taskId });
  switch (screen.kind) {
    case "result":
      return (
        <ResultScreen
          key={screen.runId}
          runId={screen.runId}
          taskId={screen.taskId}
          taskName={screen.taskId ? nameOf(screen.taskId) : undefined}
          initialRun={screen.run}
          onBack={onBack}
          onRerun={onRerun}
          onOpenRun={openRun}
          onOpenBatch={(batchId) => onPush({ kind: "batch", batchId })}
        />
      );
    case "batch":
      return (
        <BatchScreen
          key={screen.batchId}
          batchId={screen.batchId}
          taskName={nameOf}
          refreshKey={refreshKey}
          onBack={onBack}
          onOpenRun={openRun}
        />
      );
    case "editor":
      return (
        <TaskEditor
          key={screen.taskName ?? screen.copyOf ?? "new"}
          taskName={screen.taskName}
          copyOf={screen.copyOf}
          template={screen.template}
          onCancel={onBack}
          onSaved={(name, warnings) => {
            onSaved(warnings);
            // A new task opens on its page; an edit returns where it came from.
            onReplaceTop(screen.taskName ? null : { kind: "task", taskName: name });
          }}
        />
      );
    case "task": {
      const summary = tasks.find((t) => t.name === screen.taskName);
      return (
        <TaskPage
          key={screen.taskName}
          taskName={screen.taskName}
          refreshKey={refreshKey}
          busy={summary ? busy[summary.id] : undefined}
          actions={taskActions}
          onBack={onBack}
        />
      );
    }
  }
}
