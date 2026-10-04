export function ConfirmDialog({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: modal overlay dismiss on click
    // biome-ignore lint/a11y/noStaticElementInteractions: modal overlay dismiss on click
    <div className="confirm-overlay" onClick={onCancel}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation container */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation container */}
      <div className="confirm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">Delete automation?</div>
        <div className="confirm-desc">
          This will permanently remove <strong>{name}</strong>. Run history will be preserved.
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
