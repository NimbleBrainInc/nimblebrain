import { useDataSync, useTrail } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskRun, TaskSummary, TaskWarning } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, toolErrorText } from "../utils.ts";
import { ActivityView } from "./ActivityView.tsx";
import { BatchDialog } from "./BatchDialog.tsx";
import { BatchScreen } from "./BatchPane.tsx";
import { HostTrailContext, PageHeader } from "./Chrome.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { type HomeActions, HomeView } from "./HomeView.tsx";
import { ResultScreen } from "./ResultView.tsx";
import { RunDialog, type RunStarted, runStartedOf } from "./RunDialog.tsx";
import { TaskEditor } from "./TaskEditor.tsx";
import { TaskPage, type TaskPageActions } from "./TaskPage.tsx";
import { type Screen, trailFor, withRun } from "./trail.ts";
import { UpcomingView } from "./UpcomingView.tsx";

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

/** A task the panel acts on: its id and name, and its input schema when the list has it. */
type TaskRef = { id: string; name: string; inputSchema?: Record<string, unknown> };

export function TasksUI() {
  const listTool = useTool<string>("list");
  const runTool = useTool<string>("run");
  const updateTool = useTool<string>("update");
  const deleteTool = useTool<string>("delete");

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
  const trail = useMemo(() => trailFor(stack), [stack]);
  const hostShowsTrail = useTrail(
    trail.map(({ id, label }) => ({ id, label })),
    (id) => {
      const step = trail.find((s) => s.id === id);
      if (step) setStack(step.stack);
    },
  );

  const top = stack[stack.length - 1];
  const push = (s: Screen) => setStack((prev) => [...prev, s]);
  const pop = () => {
    setNotice(null);
    setStack((prev) => prev.slice(0, -1));
  };
  /** Open a run under its task's page, so its crumb leads to the task. */
  const openRun = (runId: string, taskId?: string, run?: TaskRun, batchId?: string) =>
    setStack((prev) =>
      withRun(
        prev,
        { kind: "result", runId, taskId, run, ...(batchId ? { batchId } : {}) },
        taskId ? nameOf(taskId) : undefined,
      ),
    );

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
      openRun(started.run.id, started.run.taskId, started.run);
    } else {
      setNotice(started.note);
      openRun(started.runId, started.taskId);
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

  const homeActions: HomeActions = {
    onOpenTask: (t) => push({ kind: "task", taskName: t.name }),
    onOpenRun: (taskId, runId) => openRun(runId, taskId),
    onCreate: (template) => push({ kind: "editor", template: template ?? null }),
    onSeeUpcoming: () => push({ kind: "upcoming" }),
    onSeeActivity: () => push({ kind: "activity" }),
  };

  const taskActions: TaskPageActions = {
    onRunNow: (d) => void runNow({ id: d.id, name: d.name, inputSchema: d.inputSchema }),
    onRunList: (d) => setBatchDialog(d.name),
    onEdit: (d) => push({ kind: "editor", taskName: d.name }),
    onDuplicate: (d) => push({ kind: "editor", copyOf: d.name }),
    onDelete: (d) => setConfirmDelete({ id: d.id, name: d.name }),
    onSetEnabled: (d, enabled) => setEnabled(d, enabled),
    onOpenRun: (run) => openRun(run.id, run.taskId, run),
    onSeeRuns: (d) => push({ kind: "activity", taskId: d.id, taskName: d.name }),
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

  const taskSummary = top?.kind === "task" ? tasks.find((t) => t.name === top.taskName) : undefined;

  return (
    <HostTrailContext.Provider value={hostShowsTrail}>
      {top?.kind === "task" ? (
        <TaskPage
          key={top.taskName}
          taskName={top.taskName}
          summary={taskSummary}
          refreshKey={refreshKey}
          busy={taskSummary ? busy[taskSummary.id] : undefined}
          actions={taskActions}
          onBack={pop}
        />
      ) : top ? (
        <ScreenRoute
          screen={top}
          tasks={tasks}
          refreshKey={refreshKey}
          onBack={pop}
          onPush={push}
          onRunLoaded={(runId, run) =>
            setStack((prev) =>
              prev.map((s) =>
                s.kind === "result" && s.runId === runId && !s.run ? { ...s, run } : s,
              ),
            )
          }
          onOpenRun={openRun}
          onReplaceTop={(s) => setStack((prev) => [...prev.slice(0, -1), ...(s ? [s] : [])])}
          onRerun={(task, input) => void runNow(task, input)}
          onSaved={(warnings) => {
            setNotice(warnings.length > 0 ? warnings.map((w) => w.message).join(" ") : null);
            refresh();
          }}
        />
      ) : (
        <div className="app">
          <HomeView
            tasks={tasks}
            loading={loading}
            error={error}
            refreshKey={refreshKey}
            actions={homeActions}
          />
        </div>
      )}
      {dialogs}
    </HostTrailContext.Provider>
  );
}

/** The screen on top of the stack. */
function ScreenRoute({
  screen,
  tasks,
  refreshKey,
  onBack,
  onPush,
  onRunLoaded,
  onOpenRun,
  onReplaceTop,
  onRerun,
  onSaved,
}: {
  screen: Screen;
  tasks: TaskSummary[];
  refreshKey: number;
  onBack: () => void;
  onPush: (s: Screen) => void;
  onRunLoaded: (runId: string, run: TaskRun) => void;
  onOpenRun: (runId: string, taskId?: string, run?: TaskRun, batchId?: string) => void;
  onReplaceTop: (s: Screen | null) => void;
  onRerun: (task: TaskRef, input: unknown) => void;
  onSaved: (warnings: TaskWarning[]) => void;
}) {
  const nameOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.name;
  const openRun = onOpenRun;
  switch (screen.kind) {
    case "result":
      return (
        <ResultScreen
          key={screen.runId}
          runId={screen.runId}
          taskId={screen.taskId}
          taskName={screen.taskId ? nameOf(screen.taskId) : undefined}
          initialRun={screen.run}
          batchId={screen.batchId}
          onBack={onBack}
          onRerun={onRerun}
          onOpenRun={openRun}
          onOpenBatch={(batchId) => onPush({ kind: "batch", batchId })}
          onRunLoaded={(run) => onRunLoaded(screen.runId, run)}
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
          onOpenRun={(runId, taskId) => openRun(runId, taskId, undefined, screen.batchId)}
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
    case "upcoming":
      return (
        <div className="app">
          <PageHeader title="Coming up" onBack={onBack} />
          <main className="content">
            <UpcomingView
              refreshKey={refreshKey}
              onOpenRun={(r) => r.runId && openRun(r.runId, r.taskId, undefined, r.batchId)}
              onOpenTask={(name) => onPush({ kind: "task", taskName: name })}
            />
          </main>
        </div>
      );
    case "activity":
      return (
        <div className="app">
          <PageHeader
            title={screen.taskName ? `${screen.taskName} runs` : "Every run"}
            onBack={onBack}
          />
          <main className="content">
            <ActivityView
              tasks={tasks}
              taskId={screen.taskId}
              refreshKey={refreshKey}
              onOpenRun={(run) => onOpenRun(run.id, run.taskId, run)}
              onOpenBatch={(batch) => onPush({ kind: "batch", batchId: batch.id, batch })}
            />
          </main>
        </div>
      );
    case "task":
      // Drawn by the caller, which holds the task actions.
      return null;
  }
}
