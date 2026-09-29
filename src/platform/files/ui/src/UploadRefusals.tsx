import type { UploadRefusal } from "./upload";

interface UploadRefusalsProps {
  refusal: UploadRefusal;
  onDismiss: () => void;
}

/** Names each file the host refused on upload, and why. */
export function UploadRefusals({ refusal, onDismiss }: UploadRefusalsProps) {
  const count = refusal.errors.length;
  return (
    <div className="error-banner upload-refusals" role="alert">
      <div className="upload-refusals-head">
        <span>
          {count === 1 ? "1 file wasn't uploaded" : `${count} files weren't uploaded`}
          {refusal.stored > 0 ? ` (${refusal.stored} uploaded)` : ""}
        </span>
        <button type="button" className="upload-refusals-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <ul>
        {refusal.errors.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}
