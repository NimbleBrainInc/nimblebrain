import { useState } from "react";

export function InlineEditTextarea({
  value,
  onSave,
  onCancel,
}: {
  value: string;
  onSave: (val: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div>
      <textarea
        className="inline-edit-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        // biome-ignore lint/a11y/noAutofocus: intentional focus on edit activation
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSave(draft);
        }}
      />
      <div className="inline-edit-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onSave(draft)}
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

export function InlineEditInput({
  value,
  onSave,
  onCancel,
  type,
}: {
  value: string;
  onSave: (val: string) => void;
  onCancel: () => void;
  type?: string;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div>
      <input
        className="inline-edit-input"
        type={type || "text"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        // biome-ignore lint/a11y/noAutofocus: intentional focus on edit activation
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter") onSave(draft);
        }}
        onBlur={() => onSave(draft)}
      />
    </div>
  );
}
