import { useEffect, useState } from "react";
import type { TaskDetail, TaskRun } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, toolErrorText } from "../utils.ts";
import { InputEditor, type InputState } from "./InputEditor.tsx";
import { Modal } from "./Modal.tsx";

/** Where a Run now went: a finished run to open, or a run id still going. */
export type RunStarted =
  | { kind: "finished"; run: TaskRun }
  | { kind: "pending"; runId: string; taskId: string; note: string };

/** Read `tasks__run`'s answer: a finished run, or a queued or dispatched run's id. */
export function runStartedOf(data: Record<string, unknown>): RunStarted | null {
  const run = data.run as TaskRun | undefined;
  if (run) return { kind: "finished", run };
  if (typeof data.runId === "string" && typeof data.taskId === "string") {
    const note =
      data.status === "queued"
        ? `Waiting for a run slot (position ${String(data.position ?? "?")}).`
        : "Still running; it continues in the background.";
    return { kind: "pending", runId: data.runId, taskId: data.taskId, note };
  }
  return null;
}

/**
 * Run now for a task with an input schema: asks for the input first, as a
 * form or JSON. A task without one runs straight from its row instead.
 */
export function RunDialog({
  taskId,
  taskName,
  inputSchema,
  onClose,
  onStarted,
}: {
  taskId: string;
  taskName: string;
  /** The task's input schema when the caller has it; read from the task otherwise. */
  inputSchema?: Record<string, unknown>;
  onClose: () => void;
  onStarted: (started: RunStarted) => void;
}) {
  const statusTool = useTool<string>("status");
  const runTool = useTool<string>("run");
  const [schema, setSchema] = useState<Record<string, unknown> | null | undefined>(
    inputSchema ?? undefined,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState<InputState>({ ok: true, input: undefined });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: statusTool.call is stable
  useEffect(() => {
    if (inputSchema) return;
    statusTool
      .call({ name: taskId, limit: 1 })
      .then((res) =>
        setSchema((asDict(res.data).task as TaskDetail | undefined)?.inputSchema ?? null),
      )
      .catch((err) => setLoadError(toolErrorText(err)));
  }, [taskId]);

  async function run() {
    if (!input.ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await runTool.call({
        taskId,
        ...(input.input !== undefined ? { input: input.input } : {}),
      });
      const started = runStartedOf(asDict(res.data));
      if (!started) throw new Error("The run did not start.");
      onStarted(started);
    } catch (err) {
      setError(toolErrorText(err, "The run did not start."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Run ${taskName}`} onClose={onClose} wide>
      {loadError && <div className="error-banner">{loadError}</div>}
      {schema === undefined && !loadError && <div className="skel skel-row" />}
      {schema !== undefined && <InputEditor schema={schema ?? undefined} onChange={setInput} />}
      {error && <div className="error-banner">{error}</div>}
      <div className="confirm-actions">
        {!input.ok && <span className="field-error">{input.error}</span>}
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-accent"
          disabled={schema === undefined || !input.ok || busy}
          onClick={run}
        >
          {busy ? "Starting…" : "Run now"}
        </button>
      </div>
    </Modal>
  );
}
