import { useState } from "react";
import { defaultOnceLocal, isoFromLocalInput, localInputFromIso } from "./SchedulePicker.tsx";

/**
 * Inline editor for a task's schedule. `schedule` null is a task
 * with none (manual only); saving "Manual only" sends `null`, which clears it.
 */
export function ScheduleEditor({
  schedule,
  onSave,
  onCancel,
}: {
  schedule: Record<string, unknown> | null;
  onSave: (spec: Record<string, unknown> | null) => void;
  onCancel: () => void;
}) {
  const initialType = schedule ? (schedule.type as string) || "interval" : "manual";
  const initialMinutes = schedule?.intervalMs ? Number(schedule.intervalMs) / 60_000 : 30;
  const initialExpression = (schedule?.expression as string) || "";
  const initialTimezone = (schedule?.timezone as string) || "Pacific/Honolulu";
  // A once that has run keeps its old time; the editor offers a fresh one to re-arm it.
  const initialAt = localInputFromIso(schedule?.at as string | undefined);

  const [type, setType] = useState(initialType);
  const [minutes, setMinutes] = useState(initialMinutes);
  const [expression, setExpression] = useState(initialExpression);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [onceAt, setOnceAt] = useState(
    initialAt && new Date(initialAt).getTime() > Date.now() ? initialAt : defaultOnceLocal(),
  );

  // An event schedule is not editable here. This picker writes a cron or an
  // interval and nothing else, so offering it for an event task would
  // convert one to a timer the moment anybody pressed Save — silently deleting
  // the match and the fire ceiling. Read-only until the picker learns the shape.
  if (initialType === "event") {
    return (
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
        Runs on routed notifications, not on a clock. Edit it from chat or the API.
        <div style={{ marginTop: 6 }}>
          <button type="button" className="btn" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  }

  function handleSave() {
    if (type === "manual") {
      onSave(null);
    } else if (type === "once") {
      onSave({ type: "once", at: isoFromLocalInput(onceAt) });
    } else if (type === "interval") {
      onSave({ type: "interval", intervalMs: Math.max(1, minutes) * 60_000 });
    } else {
      onSave({ type: "cron", expression, timezone });
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="inline-edit-input"
          style={{ width: "auto", marginBottom: 4 }}
        >
          <option value="interval">Interval</option>
          <option value="cron">Cron</option>
          <option value="once">Once at…</option>
          <option value="manual">Manual only</option>
        </select>
      </div>
      {type === "manual" ? (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          Nothing runs it on its own. Run it with Run Now.
        </div>
      ) : type === "once" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>At</span>
          <input
            className="inline-edit-input"
            type="datetime-local"
            value={onceAt}
            onChange={(e) => setOnceAt(e.target.value)}
            style={{ width: 200 }}
            // biome-ignore lint/a11y/noAutofocus: intentional focus on edit activation
            autoFocus
          />
        </div>
      ) : type === "interval" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Every</span>
          <input
            className="inline-edit-input"
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            style={{ width: 60 }}
            // biome-ignore lint/a11y/noAutofocus: intentional focus on edit activation
            autoFocus
          />
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>minutes</span>
        </div>
      ) : (
        <div>
          <input
            className="inline-edit-input"
            type="text"
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            placeholder="0 8 * * *"
            // biome-ignore lint/a11y/noAutofocus: intentional focus on edit activation
            autoFocus
            style={{ marginBottom: 4 }}
          />
          <input
            className="inline-edit-input"
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Pacific/Honolulu"
          />
        </div>
      )}
      <div className="inline-edit-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleSave}
          style={{
            borderColor: "var(--color-text-accent)",
            color: "var(--color-text-accent)",
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
