import { open } from "@nimblebrain/synapse";
import { useApp, useToolResult } from "@nimblebrain/synapse/react";
import { useEffect, useState } from "react";
import type { TaskDetail } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, formatWhen, toolErrorText } from "../utils.ts";
import { runStartedOf } from "./RunDialog.tsx";

/** The panel's own placement, which `open` puts on screen. */
const PANEL_URI = "ui://tasks/panel";

/** The id of the task a `tasks__create` result saved, or null before one arrives. */
export function savedTaskId(structured: unknown): string | null {
  const task = asDict(asDict(structured).task);
  return typeof task.id === "string" ? task.id : null;
}

/** Whether a schedule or event can still run it on its own. */
function runsOnItsOwn(task: TaskDetail): boolean {
  return !!task.schedule && !task.onceDone;
}

/** What happens next, in a sentence, or null for a task only a person runs. */
export function nextLine(task: TaskDetail): string | null {
  if (!runsOnItsOwn(task)) return null;
  if (!task.enabled) return "Paused: it won't run until you turn it on";
  return task.nextRunAt ? `First run ${formatWhen(task.nextRunAt)}` : null;
}

/** The task as chat shows it once saved: what, when, and what happens next. */
export function SavedCardBody({
  task,
  note,
  error,
  busy,
  onTry,
  onToggle,
  onOpen,
}: {
  task: TaskDetail | null;
  /** What the last action did, in a sentence. */
  note: string | null;
  error: string | null;
  busy: boolean;
  onTry: () => void;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
}) {
  if (!task) {
    return (
      <div className="saved-card" aria-busy={!error}>
        {error ? (
          <p className="muted">{error}</p>
        ) : (
          <div className="skel skel-row" aria-hidden="true" />
        )}
      </div>
    );
  }
  const scheduled = runsOnItsOwn(task);
  const when = scheduled ? task.scheduleHuman : "Only when you run it";
  const next = nextLine(task);
  return (
    <div className="saved-card">
      <div className="saved-card-head">
        <span className="saved-card-eyebrow">Scheduled task saved</span>
        <span className="saved-card-name">{task.name}</span>
      </div>
      <dl className="saved-card-facts">
        <dt>When</dt>
        <dd>{when}</dd>
        <dt>Does</dt>
        <dd className="saved-card-prompt">{task.prompt || task.description || "Its skills"}</dd>
        {next && (
          <>
            <dt>Next</dt>
            <dd>{next}</dd>
          </>
        )}
      </dl>
      {note && <p className="hint">{note}</p>}
      {error && <p className="warn-text">{error}</p>}
      <div className="saved-card-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onTry}>
          Try it now
        </button>
        {scheduled && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => onToggle(!task.enabled)}
          >
            {task.enabled ? "Pause" : "Turn on"}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onOpen}>
          Open in Scheduled
        </button>
      </div>
    </div>
  );
}

/**
 * The view chat shows under a `tasks__create` call: the task it saved, read
 * back in plain words, with a try, a pause, and a way to the panel.
 */
export function SavedCard() {
  const app = useApp();
  const result = useToolResult();
  const statusTool = useTool<string>("status");
  const runTool = useTool<string>("run");
  const updateTool = useTool<string>("update");
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const taskId = savedTaskId(result?.structuredContent);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    statusTool
      .call({ taskId, limit: 0 })
      .then((res) => {
        const d = asDict(res.data).task as TaskDetail | undefined;
        if (!cancelled) setTask(d ?? null);
        if (!d && !cancelled) setError("This task is no longer saved.");
      })
      .catch((err) => {
        if (!cancelled) setError(toolErrorText(err, "This task could not be read."));
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, statusTool]);

  async function act(what: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      setNote(await what());
    } catch (err) {
      setError(toolErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SavedCardBody
      task={task}
      note={note}
      error={result && !taskId ? "Nothing was saved." : error}
      busy={busy || !task}
      onTry={() =>
        void act(async () => {
          if (!task) return "";
          const res = await runTool.call({ taskId: task.id });
          const started = runStartedOf(asDict(res.data));
          return started?.kind === "finished"
            ? "It ran. Open it in Scheduled to see the result."
            : "It's running. The result will be in Scheduled.";
        })
      }
      onToggle={(enabled) =>
        void act(async () => {
          if (!task) return "";
          await updateTool.call({ taskId: task.id, manifest: { enabled } });
          setTask({ ...task, enabled });
          return enabled ? "Turned on." : "Paused.";
        })
      }
      onOpen={() => void open(app, PANEL_URI)}
    />
  );
}
