import { useApp } from "@nimblebrain/synapse/react";
import { type ReactNode, useEffect, useState } from "react";
import { FolderIcon } from "./icons";
import { Overlay } from "./Overlay";
import { type Crumb, type Folder, type ListResult, ROOT } from "./types";

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Overlay label={title} className="modal-panel" onClose={onClose}>
      <div className="modal-title">{title}</div>
      {children}
    </Overlay>
  );
}

/** Ask before a destructive action. `onConfirm` resolves when the action is done. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-message">{message}</div>
      <div className="modal-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onConfirm();
            onClose();
          }}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Name a new folder, or rename one. `onSubmit` rejects with the server's reason. */
export function NameDialog({
  title,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      {/* No <form>: the host's sandbox withholds allow-forms, so a submit is
          blocked before any handler runs. Enter and the button call `submit`. */}
      <div className="name-form">
        <input
          className="text-input"
          aria-label="Folder name"
          value={name}
          maxLength={255}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !name.trim() || name.includes("/")}
            onClick={submit}
          >
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Pick a folder to move into: drill in by clicking, go up by the dialog's own
 * breadcrumb, and make a folder on the way. `excluded` are folders being moved,
 * which cannot hold themselves.
 */
export function MoveDialog({
  count,
  startFolderId,
  excluded,
  onMove,
  onClose,
}: {
  count: number;
  startFolderId: string;
  excluded: ReadonlySet<string>;
  onMove: (folderId: string) => Promise<void>;
  onClose: () => void;
}) {
  const app = useApp();
  const [folderId, setFolderId] = useState(startFolderId);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const [refresh, setRefresh] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` re-reads after a folder is made
  useEffect(() => {
    let live = true;
    setLoading(true);
    app
      .callTool<ListResult>("list", { folderId, limit: 1 })
      .then((res) => {
        if (!live) return;
        if (res.isError) throw new Error("Couldn’t load folders");
        setFolders(res.data.folders);
        setBreadcrumb(res.data.breadcrumb);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [app, folderId, refresh]);

  async function move() {
    setBusy(true);
    setError(null);
    try {
      await onMove(folderId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const here = breadcrumb.length > 0 ? (breadcrumb[breadcrumb.length - 1]?.name ?? "") : "Files";

  return (
    <Modal title={`Move ${count} item${count === 1 ? "" : "s"}`} onClose={onClose}>
      <nav className="picker-trail" aria-label="Destination">
        <button type="button" className="crumb" onClick={() => setFolderId(ROOT)}>
          Files
        </button>
        {breadcrumb.map((c) => (
          <span key={c.id} className="crumb-step">
            <span className="crumb-sep">/</span>
            <button type="button" className="crumb" onClick={() => setFolderId(c.id)}>
              {c.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="picker-list">
        {loading ? (
          <div className="picker-empty">Loading…</div>
        ) : folders.length === 0 ? (
          <div className="picker-empty">No folders here.</div>
        ) : (
          folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className="picker-row"
              disabled={excluded.has(f.id)}
              onClick={() => setFolderId(f.id)}
            >
              <FolderIcon size={16} />
              {f.name}
            </button>
          ))
        )}
      </div>
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn-ghost" onClick={() => setNaming(true)}>
          New folder
        </button>
        <span className="modal-spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || loading || excluded.has(folderId)}
          onClick={move}
        >
          {busy ? "Moving…" : `Move to ${here}`}
        </button>
      </div>
      {naming && (
        <NameDialog
          title="New folder"
          initial=""
          submitLabel="Create"
          onClose={() => setNaming(false)}
          onSubmit={async (name) => {
            const res = await app.callTool<Folder>("create_folder", {
              manifest: { name, ...(folderId === ROOT ? {} : { parentId: folderId }) },
            });
            if (res.isError) throw new Error(errorText(res.data));
            setRefresh((n) => n + 1);
          }}
        />
      )}
    </Modal>
  );
}

/** The `error` a failed files tool call carries, as its text. */
export function errorText(data: unknown): string {
  const message = (data as { error?: unknown } | null)?.error;
  return typeof message === "string" ? message : "Something went wrong";
}
