import { useEffect, useId, useState } from "react";
import { type ParsedItems, parseItems } from "../lib/csv.ts";
import type { TaskBatch, TaskDetail } from "../types.ts";
import { useTool } from "../useTool.ts";
import { asDict, toolErrorText } from "../utils.ts";
import { Modal } from "./Modal.tsx";

/** The batch tool's arguments from the form; `problem` when one field is bad. */
export function batchArgs(f: {
  taskId: string;
  items: unknown[];
  concurrency: string;
  budgetUsd: string;
  stopRule: boolean;
  minPassPercent: string;
  afterItems: string;
}): { args?: Record<string, unknown>; problem?: string } {
  const args: Record<string, unknown> = { taskId: f.taskId, items: f.items };
  if (f.concurrency.trim()) {
    const n = Number(f.concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { problem: "Concurrency is 1 to 100." };
    args.concurrency = n;
  }
  if (f.budgetUsd.trim()) {
    const n = Number(f.budgetUsd);
    if (!Number.isFinite(n) || n <= 0) return { problem: "The budget is a dollar amount above 0." };
    args.budgetUsd = n;
  }
  if (f.stopRule) {
    const pct = Number(f.minPassPercent);
    const after = Number(f.afterItems);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { problem: "The pass rate is 0 to 100%." };
    }
    if (!Number.isInteger(after) || after < 1) {
      return { problem: "Check the pass rate after at least 1 item." };
    }
    args.stopWhen = { minPassRate: pct / 100, afterItems: after };
  }
  return { args };
}

/** The input schema's property names: the CSV columns a list maps to. */
function schemaColumns(schema: Record<string, unknown> | undefined): string[] {
  const props = schema?.properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

/** The pasted or loaded items, with what was parsed or what is wrong. */
function ItemsField({
  text,
  columns,
  parsed,
  onText,
  onError,
}: {
  text: string;
  columns: string[];
  parsed: ParsedItems;
  onText: (t: string) => void;
  onError: (e: string) => void;
}) {
  const id = useId();
  const count = parsed.items.length;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Items: a JSON array, or CSV with a header row
      </label>
      <textarea
        id={id}
        className="inline-edit-textarea"
        rows={8}
        value={text}
        spellCheck={false}
        onChange={(e) => onText(e.target.value)}
        placeholder={
          columns.length > 0
            ? `${columns.join(",")}\n…`
            : '[{ "company": "Acme" }, { "company": "Globex" }]'
        }
      />
      <div className="hint">
        {columns.length > 0
          ? `CSV columns map to the task's input fields: ${columns.join(", ")}.`
          : "Each item becomes one run's input."}{" "}
        <label className="link-btn file-pick">
          Load a file
          <input
            type="file"
            accept=".csv,.json,text/csv,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) f.text().then(onText, () => onError("Could not read that file."));
            }}
          />
        </label>
      </div>
      {parsed.errors.map((e) => (
        <div key={e} className="field-error">
          {e}
        </div>
      ))}
      {count > 0 && (
        <div className="hint">
          {count} item{count === 1 ? "" : "s"} from {parsed.format === "csv" ? "CSV" : "JSON"}
        </div>
      )}
    </div>
  );
}

/** A labelled number input. */
function NumberField({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="inline-edit-input"
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    </div>
  );
}

/** The stop rule: pause when the pass rate falls below a floor after some items. */
function StopRuleFields({
  assessable,
  known,
  on,
  minPassPercent,
  afterItems,
  onOn,
  onMin,
  onAfter,
}: {
  assessable: boolean;
  known: boolean;
  on: boolean;
  minPassPercent: string;
  afterItems: string;
  onOn: (v: boolean) => void;
  onMin: (v: string) => void;
  onAfter: (v: string) => void;
}) {
  return (
    <div className="field">
      <label className="check">
        <input
          type="checkbox"
          checked={on && assessable}
          disabled={!assessable}
          onChange={(e) => onOn(e.target.checked)}
        />
        Pause if the pass rate falls
      </label>
      {!assessable && known && (
        <div className="hint">Needs criteria or an output schema on the task.</div>
      )}
      {on && assessable && (
        <div className="field-row">
          <NumberField
            label="Below (%)"
            min={0}
            max={100}
            value={minPassPercent}
            onChange={onMin}
          />
          <NumberField label="After items" min={1} value={afterItems} onChange={onAfter} />
        </div>
      )}
    </div>
  );
}

/** Run on a list…: one run of the task per pasted item, with a budget and a stop rule. */
export function BatchDialog({
  taskName,
  onClose,
  onCreated,
}: {
  taskName: string;
  onClose: () => void;
  onCreated: (batch: TaskBatch) => void;
}) {
  const statusTool = useTool<string>("status");
  const batchTool = useTool<string>("run_batch");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [text, setText] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [stopRule, setStopRule] = useState(false);
  const [minPassPercent, setMinPassPercent] = useState("80");
  const [afterItems, setAfterItems] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: statusTool.call is stable
  useEffect(() => {
    statusTool
      .call({ name: taskName, limit: 1 })
      .then((res) => setDetail((asDict(res.data).task as TaskDetail) ?? null))
      .catch((err) => setError(toolErrorText(err)));
  }, [taskName]);

  const parsed = parseItems(text, detail?.inputSchema);
  const assessable = !!(detail?.criteria?.length || detail?.outputSchema);
  const form = detail
    ? batchArgs({
        taskId: detail.id,
        items: parsed.items,
        concurrency,
        budgetUsd,
        stopRule: stopRule && assessable,
        minPassPercent,
        afterItems,
      })
    : {};
  const count = parsed.items.length;
  const ready = !busy && !!form.args && count > 0 && parsed.errors.length === 0;

  async function start() {
    if (!form.args) return;
    setBusy(true);
    setError(null);
    try {
      const res = await batchTool.call(form.args);
      const batch = asDict(res.data).batch as TaskBatch | undefined;
      if (!batch) throw new Error("The batch did not start.");
      onCreated(batch);
    } catch (err) {
      setError(toolErrorText(err, "The batch did not start."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Run ${taskName} on a list`} onClose={onClose} wide>
      <ItemsField
        text={text}
        columns={schemaColumns(detail?.inputSchema)}
        parsed={parsed}
        onText={setText}
        onError={setError}
      />
      <div className="field-row">
        <NumberField
          label="At once"
          min={1}
          max={100}
          value={concurrency}
          placeholder="Default"
          onChange={setConcurrency}
        />
        <NumberField
          label="Budget (USD)"
          min={0}
          step="0.5"
          value={budgetUsd}
          placeholder="No limit"
          onChange={setBudgetUsd}
        />
      </div>
      <StopRuleFields
        assessable={assessable}
        known={!!detail}
        on={stopRule}
        minPassPercent={minPassPercent}
        afterItems={afterItems}
        onOn={setStopRule}
        onMin={setMinPassPercent}
        onAfter={setAfterItems}
      />
      {error && <div className="error-banner">{error}</div>}
      <div className="confirm-actions">
        {form.problem && <span className="field-error">{form.problem}</span>}
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-accent" disabled={!ready} onClick={start}>
          {busy ? "Starting…" : `Start ${count || ""} run${count === 1 ? "" : "s"}`}
        </button>
      </div>
    </Modal>
  );
}
