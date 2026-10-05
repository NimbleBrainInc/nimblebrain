import { Modal } from "./Modal.tsx";

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
    <Modal title="Delete task?" onClose={onCancel}>
      <div className="confirm-desc">
        This permanently removes <strong>{name}</strong> and stops its trigger. Its run history
        stays in Activity.
      </div>
      <div className="confirm-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Keep it
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          Delete
        </button>
      </div>
    </Modal>
  );
}
