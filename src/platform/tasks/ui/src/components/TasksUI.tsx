import { hostSupports } from "@nimblebrain/synapse";
import { useApp, useDataSync } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon } from "../icons.tsx";
import type { TaskRun, TaskSummary, TaskWarning } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, toolErrorText } from "../utils.ts";
import { ActivityView } from "./ActivityView.tsx";
import { BatchDialog } from "./BatchDialog.tsx";
import { BatchScreen } from "./BatchPane.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ResultScreen } from "./ResultView.tsx";
import { RunDialog, type RunStarted, runStartedOf } from "./RunDialog.tsx";
import { type SavedActions, SavedView } from "./SavedView.tsx";
import { TaskDetailView } from "./TaskDetailView.tsx";
import { TaskEditor } from "./TaskEditor.tsx";
import type { Template } from "./templates.ts";
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

export type View = "saved" | "upcoming" | "activity";

const VIEWS: Array<{ id: View; text: string }> = [
  { id: "saved", text: "Saved" },
  { id: "upcoming", text: "Upcoming" },
  { id: "activity", text: "Activity" },
];

/** A screen over the views: one run's result, a batch, the editor, or a task's details. */
type Screen =
  | { kind: "result"; runId: string; taskId?: string; run?: TaskRun }
  | { kind: "batch"; batchId: string }
  | { kind: "editor"; taskName?: string; template?: Template | null }
  | { kind: "detail"; taskName: string };

/** The view switcher: a tab list, arrow keys move between tabs. */
export function ViewTabs({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="view-tabs" role="tablist" aria-label="Tasks views">
      {VIEWS.map((v, i) => (
        <button
          key={v.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`tab-${v.id}`}
          aria-selected={view === v.id}
          aria-controls="view-panel"
          tabIndex={view === v.id ? 0 : -1}
          className={`view-tab${view === v.id ? " on" : ""}`}
          onClick={() => onChange(v.id)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const next = (i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length;
            onChange(VIEWS[next]!.id);
            refs.current[next]?.focus();
          }}
        >
          {v.text}
        </button>
      ))}
    </div>
  );
}

export function TasksUI() {
  const app = useApp();
  // The host draws this view's title in its own chrome when it declares
  // `ai.nimblebrain/location`, so the view leaves its own out rather than say it
  // twice. A host without it (any other MCP Apps host) gets the view's title.
  const hostShowsTitle = hostSupports(app, "location");
  const listTool = useTool<string>("list");
  const statusTool = useTool<string>("status");
  const runTool = useTool<string>("run");
  const updateTool = useTool<string>("update");
  const deleteTool = useTool<string>("delete");
  const cancelTool = useTool<string>("cancel");

  const [view, setView] = useState<View>("saved");
  const [stack, setStack] = useState<Screen[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [runDialog, setRunDialog] = useState<string | null>(null);
  const [batchDialog, setBatchDialog] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TaskSummary | null>(null);

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

  const top = stack[stack.length - 1];
  const push = (s: Screen) => setStack((prev) => [...prev, s]);
  const pop = () => setStack((prev) => prev.slice(0, -1));
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
  async function runNow(task: { id: string; name: string }, input?: unknown) {
    mark(task.id, "running");
    setNotice(null);
    try {
      if (input === undefined) {
        // A task whose runs take input asks for it first.
        const detail = await statusTool.call({ name: task.name, limit: 1 });
        const def = asDict(detail.data).task as { inputSchema?: unknown } | undefined;
        if (def?.inputSchema) {
          setRunDialog(task.name);
          return;
        }
      }
      const status = await runTool.call({
        name: task.name,
        ...(input !== undefined ? { input } : {}),
      });
      const started = runStartedOf(asDict(status.data));
      if (started) openStarted(started);
    } catch (err) {
      setNotice(toolErrorText(err, "The run did not start."));
    } finally {
      mark(task.id, null);
      refresh();
    }
  }

  async function toggle(task: TaskSummary) {
    mark(task.id, task.enabled ? "pausing" : "resuming");
    try {
      await updateTool.call({ name: task.name, manifest: { enabled: !task.enabled } });
    } catch (err) {
      setNotice(toolErrorText(err));
    } finally {
      mark(task.id, null);
      refresh();
    }
  }

  async function remove(task: TaskSummary) {
    setConfirmDelete(null);
    mark(task.id, "deleting");
    try {
      await deleteTool.call({ name: task.name });
      setStack((prev) => prev.filter((s) => !(s.kind === "detail" && s.taskName === task.name)));
    } catch (err) {
      setNotice(toolErrorText(err));
    } finally {
      mark(task.id, null);
      refresh();
    }
  }

  const savedActions: SavedActions = {
    onOpen: (t) => push({ kind: "detail", taskName: t.name }),
    onRunNow: (t) => void runNow(t),
    onRunList: (t) => setBatchDialog(t.name),
    onEdit: (t) => push({ kind: "editor", taskName: t.name }),
    onToggle: (t) => void toggle(t),
    onDelete: (t) => setConfirmDelete(t),
    onOpenRun: (t, runId) => push({ kind: "result", runId, taskId: t.id }),
    onCreate: (template) => push({ kind: "editor", template: template ?? null }),
  };

  const dialogs = (
    <>
      {runDialog && (
        <RunDialog
          taskName={runDialog}
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
            push({ kind: "batch", batchId: batch.id });
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
    </>
  );

  if (top) {
    return (
      <>
        {notice && top.kind !== "editor" && (
          <div className="toast" role="status">
            {notice}
          </div>
        )}
        <ScreenRoute
          screen={top}
          tasks={tasks}
          busy={busy}
          refreshKey={refreshKey}
          nav={{
            push,
            back: () => {
              setNotice(null);
              pop();
            },
            replaceTop: (s) => setStack((prev) => [...prev.slice(0, -1), ...(s ? [s] : [])]),
          }}
          actions={{
            runNow: (task, input) => void runNow(task, input),
            askRun: (name) => setRunDialog(name),
            toggle: (task) => void toggle(task),
            askDelete: (task) => setConfirmDelete(task),
            cancel: (name) => void cancelTool.call({ name }).finally(refresh),
            update: async (args) => {
              try {
                await updateTool.call(args);
              } finally {
                refresh();
              }
            },
            saved: (warnings) => {
              setNotice(warnings.length > 0 ? warnings.map((w) => w.message).join(" ") : null);
              refresh();
            },
          }}
        />
        {dialogs}
      </>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div>
            {!hostShowsTitle && <h1 className="header-title">Tasks</h1>}
            <div className="header-lede">Work the agent does on its own, and how it went</div>
          </div>
          <button type="button" className="create-btn" onClick={() => push({ kind: "editor" })}>
            <PlusIcon />
            New task
          </button>
        </div>
        <ViewTabs view={view} onChange={setView} />
      </header>
      {notice && (
        <div className="view-pad">
          <div className="note-banner" role="status">
            {notice}{" "}
            <button type="button" className="link-btn" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <main
        className="content view-panel"
        id="view-panel"
        role="tabpanel"
        aria-labelledby={`tab-${view}`}
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
            onOpenRun={(r) => r.runId && push({ kind: "result", runId: r.runId, taskId: r.taskId })}
            onOpenTask={(name) => push({ kind: "detail", taskName: name })}
          />
        )}
        {view === "activity" && (
          <ActivityView
            tasks={tasks}
            refreshKey={refreshKey}
            onOpenRun={(run) => push({ kind: "result", runId: run.id, taskId: run.taskId, run })}
            onOpenBatch={(batch) => push({ kind: "batch", batchId: batch.id })}
          />
        )}
      </main>
      {dialogs}
    </div>
  );
}

interface ScreenNav {
  push: (s: Screen) => void;
  back: () => void;
  /** Replace the top screen, or drop it with null. */
  replaceTop: (s: Screen | null) => void;
}

interface ScreenActions {
  runNow: (task: { id: string; name: string }, input?: unknown) => void;
  askRun: (taskName: string) => void;
  toggle: (task: TaskSummary) => void;
  askDelete: (task: TaskSummary) => void;
  cancel: (taskName: string) => void;
  update: (args: Record<string, unknown>) => Promise<void>;
  saved: (warnings: TaskWarning[]) => void;
}

/** The detail view saves one flat field; the update tool takes `{ name, manifest?, body? }`. */
export function updateArgsOf(
  name: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { name };
  const manifest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "prompt") args.body = v;
    else if (k !== "name") manifest[k] = v;
  }
  if (Object.keys(manifest).length > 0) args.manifest = manifest;
  return args;
}

/** The screen on top of the stack. */
function ScreenRoute({
  screen,
  tasks,
  busy,
  refreshKey,
  nav,
  actions,
}: {
  screen: Screen;
  tasks: TaskSummary[];
  busy: Record<string, string>;
  refreshKey: number;
  nav: ScreenNav;
  actions: ScreenActions;
}) {
  const nameOf = (taskId: string) => tasks.find((t) => t.id === taskId)?.name;
  const openRun = (runId: string, taskId?: string) => nav.push({ kind: "result", runId, taskId });
  switch (screen.kind) {
    case "result":
      return (
        <ResultScreen
          key={screen.runId}
          runId={screen.runId}
          taskId={screen.taskId}
          taskName={screen.taskId ? nameOf(screen.taskId) : undefined}
          initialRun={screen.run}
          onBack={nav.back}
          onRerun={(task, input) => actions.runNow(task, input)}
          onOpenRun={openRun}
          onOpenBatch={(batchId) => nav.push({ kind: "batch", batchId })}
        />
      );
    case "batch":
      return (
        <BatchScreen
          key={screen.batchId}
          batchId={screen.batchId}
          taskName={nameOf}
          refreshKey={refreshKey}
          onBack={nav.back}
          onOpenRun={openRun}
        />
      );
    case "editor":
      return (
        <TaskEditor
          key={screen.taskName ?? "new"}
          taskName={screen.taskName}
          template={screen.template}
          onCancel={nav.back}
          onSaved={(name, warnings) => {
            actions.saved(warnings);
            // A new task opens on its details; an edit returns where it came from.
            nav.replaceTop(screen.taskName ? null : { kind: "detail", taskName: name });
          }}
        />
      );
    case "detail": {
      const summary = tasks.find((t) => t.name === screen.taskName);
      return (
        <TaskDetailView
          key={screen.taskName}
          taskName={screen.taskName}
          onBack={nav.back}
          actionInProgress={summary ? busy[summary.id] : undefined}
          onRunNow={() => actions.askRun(screen.taskName)}
          onToggle={() => summary && actions.toggle(summary)}
          onDelete={() => summary && actions.askDelete(summary)}
          onCancel={() => actions.cancel(screen.taskName)}
          onEdit={() => nav.push({ kind: "editor", taskName: screen.taskName })}
          onUpdate={(name, fields) => actions.update(updateArgsOf(name, fields))}
        />
      );
    }
  }
}
