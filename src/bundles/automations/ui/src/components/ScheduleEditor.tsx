import { useState } from "react";

export function ScheduleEditor({
  schedule,
  onSave,
  onCancel,
}: {
  schedule: Record<string, unknown>;
  onSave: (spec: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const initialType = (schedule.type as string) || "interval";
  const initialMinutes = schedule.intervalMs ? Number(schedule.intervalMs) / 60_000 : 30;
  const initialExpression = (schedule.expression as string) || "";
  const initialTimezone = (schedule.timezone as string) || "Pacific/Honolulu";

  const [type, setType] = useState(initialType);
  const [minutes, setMinutes] = useState(initialMinutes);
  const [expression, setExpression] = useState(initialExpression);
  const [timezone, setTimezone] = useState(initialTimezone);

  function handleSave() {
    if (type === "interval") {
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
        </select>
      </div>
      {type === "interval" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary, #737373)" }}>Every</span>
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
          <span style={{ fontSize: 12, color: "var(--color-text-secondary, #737373)" }}>
            minutes
          </span>
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
            borderColor: "var(--color-text-accent, #0055FF)",
            color: "var(--color-text-accent, #0055FF)",
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
