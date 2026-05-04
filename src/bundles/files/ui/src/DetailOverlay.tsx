import { useEffect, useRef } from "react";
import { formatSize, isImage } from "./format";
import { FileTypeIcon } from "./icons";
import type { FileEntry } from "./types";

interface Props {
  file: FileEntry;
  deleting: boolean;
  onClose: () => void;
  onDelete: () => void;
}

/**
 * Modal detail panel. Built on the native `<dialog>` element so that:
 *   - Esc dismissal is handled by the platform (`onClose` fires)
 *   - Focus is trapped inside the dialog while open
 *   - Inert background is automatic
 *   - The `::backdrop` pseudo-element handles the dim layer (CSS-only)
 *
 * Backdrop click → close: detected by checking whether the click target was
 * the dialog itself (the backdrop is the dialog's own pseudo-element, so
 * clicks land on the dialog node, not on the panel inside).
 */
export function DetailOverlay({ file, deleting, onClose, onDelete }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: <dialog> handles Esc natively via onClose; the click handler is purely a backdrop-dismiss affordance.
    <dialog
      ref={dialogRef}
      className="detail-overlay"
      onClose={onClose}
      onClick={(e) => {
        // Click on the backdrop (target is the dialog itself) closes; clicks
        // landing on the inner panel come through with target inside it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="detail-panel">
        <div className="detail-header">
          <div className="detail-title">{file.filename}</div>
          <button type="button" className="detail-close" title="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="detail-preview">
          {isImage(file.mimeType) ? (
            <img src={`/v1/files/${file.id}`} alt={file.filename} />
          ) : (
            <FileTypeIcon mimeType={file.mimeType} size={56} />
          )}
        </div>

        <div className="detail-fields">
          <Field label="ID" value={file.id} mono />
          <Field label="Type" value={file.mimeType || "Unknown"} />
          <Field label="Size" value={formatSize(file.size || 0)} />
          <Field
            label="Created"
            value={file.createdAt ? new Date(file.createdAt).toLocaleString() : "Unknown"}
          />
          {file.source && <Field label="Source" value={file.source} />}
          {file.description && <Field label="Description" value={file.description} />}
          {file.tags && file.tags.length > 0 && (
            <div className="detail-field">
              <div className="detail-label">Tags</div>
              <div className="detail-tags">
                {file.tags.map((t) => (
                  <span key={t} className="detail-tag">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="detail-actions">
          <button type="button" className="btn-danger" disabled={deleting} onClick={onDelete}>
            {deleting ? "Deleting…" : "Delete File"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="detail-field">
      <div className="detail-label">{label}</div>
      <div className={`detail-value${mono ? " detail-id" : ""}`}>{value}</div>
    </div>
  );
}
