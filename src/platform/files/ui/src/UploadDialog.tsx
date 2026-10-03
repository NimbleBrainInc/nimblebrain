import { useEffect, useState } from "react";
import { UploadIcon } from "./icons";
import { Overlay } from "./Overlay";
import { UploadRefusals } from "./UploadRefusals";
import type { UploadOutcome } from "./useFileActions";

/**
 * Upload into the folder the reader is in: drop files on the zone, or choose
 * them with the host's picker. The limits are stated here, where they matter.
 * It closes once everything sent is stored; a refusal stays on screen, naming
 * each file and why.
 */
export function UploadDialog({
  destination,
  canDrop,
  limits,
  initialFiles,
  onUpload,
  onDone,
  onClose,
}: {
  /** Where the files land, as the reader knows it ("Files", "Reports"). */
  destination: string;
  /** Whether the host stores dropped files; without it, only the picker is offered. */
  canDrop: boolean;
  /** The host's limits, as a sentence; `null` when it gave none. */
  limits: string | null;
  /** Files dropped on the view, which opened this dialog to upload them. */
  initialFiles: readonly File[] | null;
  onUpload: (files?: readonly File[]) => Promise<UploadOutcome>;
  onDone: (stored: number) => void;
  onClose: () => void;
}) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null);

  async function run(files?: readonly File[]) {
    setBusy(files?.length ?? 0);
    setOutcome(null);
    const result = await onUpload(files);
    setBusy(null);
    if (result.refusal || result.error) {
      setOutcome(result);
      return;
    }
    // A cancelled pick stores nothing and leaves the dialog open.
    if (result.storedIds.length > 0) onDone(result.storedIds.length);
  }

  // Files dropped on the view, which opened this dialog, upload straight away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the files the dialog opened with
  useEffect(() => {
    if (initialFiles && initialFiles.length > 0) void run(initialFiles);
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    // Handled here: the view's own drop handler must not upload these again.
    e.stopPropagation();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (canDrop && files.length > 0 && busy === null) void run(files);
  }

  return (
    <Overlay
      label={`Upload to ${destination}`}
      className="modal-panel upload-panel"
      onClose={onClose}
    >
      <div className="modal-title">Upload to {destination}</div>
      <section
        className={`drop-zone${over ? " over" : ""}`}
        aria-label={canDrop ? "Drop files here" : "Choose files"}
        onDragEnter={(e) => {
          e.preventDefault();
          if (canDrop) setOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = canDrop ? "copy" : "none";
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={onDrop}
      >
        <span className="drop-icon">
          <UploadIcon size={28} />
        </span>
        {busy !== null ? (
          <div className="drop-title">
            {busy > 0 ? `Uploading ${busy} file${busy === 1 ? "" : "s"}…` : "Uploading…"}
          </div>
        ) : (
          <>
            {canDrop && <div className="drop-title">Drop files here</div>}
            {canDrop && <div className="drop-or">or</div>}
            <button type="button" className="btn-primary" onClick={() => run()}>
              Choose files
            </button>
          </>
        )}
        {limits && <div className="drop-limits">{limits}</div>}
      </section>
      {outcome?.refusal && (
        <UploadRefusals refusal={outcome.refusal} onDismiss={() => setOutcome(null)} />
      )}
      {outcome?.error && <div className="modal-error">{outcome.error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>
          {outcome ? "Done" : "Cancel"}
        </button>
      </div>
    </Overlay>
  );
}
