import { hostSupports } from "@nimblebrain/synapse";
import { useApp, useHostContext, useModelContext, useTrail } from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailOverlay } from "./DetailOverlay";
import { ConfirmDialog, errorText, MoveDialog, NameDialog } from "./Dialogs";
import { FileList } from "./FileList";
import { FolderIcon } from "./icons";
import { Pager } from "./Pager";
import { Toolbar } from "./Toolbar";
import { type Crumb, type FileEntry, type Folder, type ListResult, ROOT } from "./types";
import { UploadDialog } from "./UploadDialog";
import { type UploadLimits, uploadLimitHint } from "./upload";
import { useBrowseState } from "./useBrowseState";
import { type UploadOutcome, useFileActions } from "./useFileActions";
import { useFacets, useFileList } from "./useFileList";
import { useSelection } from "./useSelection";

/** The trail's root: the view's own placement, as the host knows it. */
const TRAIL_ROOT = { id: "ui://files/browser", label: "Files" };
/** A folder's trail address. Folders are not MCP resources, so a path of our own. */
const FOLDER_PREFIX = "folders/";
const FILE_PREFIX = "files://";

type Dialog =
  | { kind: "new-folder" }
  | { kind: "rename"; folder: Folder }
  | { kind: "move"; ids: string[] }
  | { kind: "delete"; ids: string[]; label: string }
  /** `files`: dropped on the view, to upload as the dialog opens. */
  | { kind: "upload"; files: File[] | null };

/** A file opened from the list carries its folder's path; one opened by address does not. */
type OpenFile = FileEntry & { folderPath?: string };

export function Dashboard() {
  const app = useApp();
  const { uploads } = useHostContext<{ uploads?: UploadLimits }>();
  const browse = useBrowseState();
  const list = useFileList(browse.params);
  const actions = useFileActions(list.reload);
  const [detailFile, setDetailFile] = useState<OpenFile | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const canDrop = hostSupports(app, "uploadFiles");
  // Files dragged onto the view open the upload dialog with them.
  const dragging = useViewDrop(canDrop, (files) => setDialog({ kind: "upload", files }));

  const breadcrumb = useBreadcrumb(list.result, browse.searching, browse.folderId);
  // While browsing, the chips count what choosing one would search: this
  // folder and everything below it, or everything at the top level.
  const browseFacets = useFacets(facetScope(browse));
  // Folders lead the first page; later pages are files only.
  const folders = list.page === 0 ? (list.result?.folders ?? []) : [];
  const files = list.result?.files ?? [];
  const rowIds = useMemo(() => [...folders, ...files].map((r) => r.id), [folders, files]);
  const selection = useSelection(rowIds, `${JSON.stringify(browse.params)}#${list.page}`);
  const contentRef = useRef<HTMLDivElement>(null);
  // A new page starts at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `list.page` is the trigger
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [list.page]);

  const { openFolder: goToFolder, setFolderId } = browse;
  const openFolder = useCallback(
    (id: string) => {
      goToFolder(id);
      setDetailFile(null);
    },
    [goToFolder],
  );

  const { setError } = actions;
  const openFileById = useCallback(
    async (id: string) => {
      const res = await app.callTool<FileEntry>("info", { id });
      if (res.isError) {
        setError(errorText(res.data));
        return;
      }
      setFolderId(res.data.folderId ?? ROOT);
      setDetailFile(res.data);
    },
    [app, setError, setFolderId],
  );

  // Where the app is, for the host's bar: Files, the folders down to this one,
  // then the file open over it. The host hands an address back when a level is
  // picked, and the agent opens a view by the same address.
  const trail = useMemo(() => buildTrail(breadcrumb, detailFile), [breadcrumb, detailFile]);
  const hostShowsTrail = useTrail(trail, (id) => followAddress(id, openFolder, openFileById));

  const where = breadcrumb.map((c) => c.name).join("/");
  useModelContext(
    () =>
      describeView({
        browse,
        where,
        total: list.result?.total,
        detailFile,
        selected: selection.selected,
      }),
    [browse.params, where, list.result, detailFile, selection.selected],
  );

  const scopeName = browse.inFolder ? lastName(breadcrumb) : null;
  const body = bodyState(list.loading, list.result, rowIds.length);

  async function moveAndFollow(ids: string[], target: string) {
    await actions.move(ids, target);
    selection.clear();
    // The open file moved with the selection: drop its stale path.
    setDetailFile((f) => (f && ids.includes(f.id) ? movedTo(f, target) : f));
  }

  function askRemoveSelected() {
    const ids = [...selection.selected];
    const label =
      ids.length === 1 ? nameOf(ids[0] as string, folders, files) : `${ids.length} items`;
    setDialog({ kind: "delete", ids, label });
  }

  async function removeAndFollow(ids: string[], label: string) {
    // A refused folder stays put and its refusal shows; either way the
    // selection is spent.
    const removed = await actions.remove(ids, label);
    selection.clear();
    if (removed) setDetailFile((f) => (f && ids.includes(f.id) ? null : f));
  }

  return (
    <>
      <Toolbar
        showTrail={!hostShowsTrail}
        breadcrumb={breadcrumb}
        onOpenFolder={openFolder}
        searchInput={browse.searchInput}
        onSearchInput={browse.setSearchInput}
        scopeName={scopeName}
        scoped={browse.scoped}
        onToggleScope={() => browse.setScoped((s) => !s)}
        kinds={browse.kinds}
        onToggleKind={browse.toggleKind}
        sourceKey={browse.sourceKey}
        onToggleSource={browse.toggleSource}
        since={browse.since}
        onSelectSince={browse.setSince}
        facets={browseFacets ?? list.result?.facets ?? null}
        hasFilter={browse.hasFilter}
        onClearFilters={browse.clearFilters}
        onUpload={() => setDialog({ kind: "upload", files: null })}
        onNewFolder={() => setDialog({ kind: "new-folder" })}
      />

      <SelectionBar
        count={selection.selected.size}
        onMove={() => setDialog({ kind: "move", ids: [...selection.selected] })}
        onDelete={askRemoveSelected}
        onClear={selection.clear}
      />

      <div className="notices">
        <ErrorBanner
          message={actions.error ?? list.error}
          onDismiss={() => actions.setError(null)}
        />
      </div>

      <div className="content" ref={contentRef}>
        {list.result && (
          <Pager
            page={list.page}
            pageCount={list.pageCount}
            total={list.result.total}
            onPage={list.setPage}
          />
        )}

        {body === "loading" ? (
          <LoadingRows />
        ) : body === "empty" ? (
          <EmptyState
            searching={browse.searching}
            query={browse.query}
            inFolder={browse.inFolder}
          />
        ) : (
          <FileList
            folders={folders}
            files={files}
            showLocation={browse.searching}
            sort={browse.sort}
            order={browse.order}
            onSort={browse.sortBy}
            selected={selection.selected}
            onToggleSelect={selection.toggle}
            onToggleAll={selection.toggleAll}
            onOpenFolder={openFolder}
            onOpenFile={setDetailFile}
            onRenameFolder={(folder) => setDialog({ kind: "rename", folder })}
            onDeleteFolder={(folder) =>
              setDialog({ kind: "delete", ids: [folder.id], label: folder.name })
            }
          />
        )}
        {list.pageCount > 1 && list.result && (
          <Pager
            page={list.page}
            pageCount={list.pageCount}
            total={list.result.total}
            onPage={list.setPage}
          />
        )}
      </div>

      <Toast message={actions.notice} />
      {dragging && (
        <div className="drop-hint" aria-hidden>
          Drop to upload to {lastName(breadcrumb, "Files")}
        </div>
      )}

      {detailFile && (
        <DetailOverlay
          file={detailFile}
          location={detailLocation(detailFile, where)}
          deleting={actions.deleting}
          onClose={() => setDetailFile(null)}
          onDelete={() =>
            setDialog({ kind: "delete", ids: [detailFile.id], label: detailFile.filename })
          }
          onMove={() => setDialog({ kind: "move", ids: [detailFile.id] })}
        />
      )}

      {dialog && (
        <DialogLayer
          dialog={dialog}
          folderId={browse.folderId}
          onClose={() => setDialog(null)}
          createFolder={actions.createFolder}
          renameFolder={actions.renameFolder}
          move={moveAndFollow}
          remove={removeAndFollow}
          upload={{
            destination: lastName(breadcrumb, "Files"),
            canDrop,
            limits: uploadLimitHint(uploads),
            send: (files) => actions.upload(browse.folderId, files),
            done: (n) => actions.flash(`Uploaded ${n} file${n === 1 ? "" : "s"}`),
          }}
        />
      )}
    </>
  );
}

function bodyState(loading: boolean, result: ListResult | null, rows: number) {
  if (!result) return loading ? "loading" : "list";
  return rows === 0 && !loading ? "empty" : "list";
}

function DialogLayer({
  dialog,
  folderId,
  onClose,
  createFolder,
  renameFolder,
  move,
  remove,
  upload,
}: {
  dialog: Dialog;
  folderId: string;
  onClose: () => void;
  createFolder: (name: string, parentId: string) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  move: (ids: string[], target: string) => Promise<void>;
  remove: (ids: string[], label: string) => Promise<void>;
  upload: {
    destination: string;
    canDrop: boolean;
    limits: string | null;
    send: (files?: readonly File[]) => Promise<UploadOutcome>;
    done: (stored: number) => void;
  };
}) {
  switch (dialog.kind) {
    case "new-folder":
      return (
        <NameDialog
          title="New folder"
          initial=""
          submitLabel="Create"
          onClose={onClose}
          onSubmit={(name) => createFolder(name, folderId)}
        />
      );
    case "rename":
      return (
        <NameDialog
          title="Rename folder"
          initial={dialog.folder.name}
          submitLabel="Rename"
          onClose={onClose}
          onSubmit={(name) => renameFolder(dialog.folder.id, name)}
        />
      );
    case "move":
      return (
        <MoveDialog
          count={dialog.ids.length}
          startFolderId={folderId}
          excluded={new Set(dialog.ids.filter((id) => id.startsWith("fd_")))}
          onClose={onClose}
          onMove={(target) => move(dialog.ids, target)}
        />
      );
    case "upload":
      return (
        <UploadDialog
          destination={upload.destination}
          canDrop={upload.canDrop}
          limits={upload.limits}
          initialFiles={dialog.files}
          onUpload={upload.send}
          onDone={(n) => {
            upload.done(n);
            onClose();
          }}
          onClose={onClose}
        />
      );
    case "delete":
      return (
        <ConfirmDialog
          title={`Delete ${dialog.label}?`}
          message={deleteMessage(dialog.ids)}
          confirmLabel="Delete"
          onClose={onClose}
          onConfirm={() => remove(dialog.ids, dialog.label)}
        />
      );
  }
}

/** What a chip would search from here, or `null` while a search already says. */
function facetScope(browse: ReturnType<typeof useBrowseState>): Record<string, unknown> | null {
  if (browse.searching) return null;
  return browse.inFolder ? { folderId: browse.folderId, recursive: true } : {};
}

function deleteMessage(ids: string[]): string {
  const folders = ids.some((id) => id.startsWith("fd_"));
  return folders
    ? "This cannot be undone. A folder is deleted only when it is empty."
    : "This cannot be undone.";
}

function buildTrail(breadcrumb: Crumb[], detailFile: OpenFile | null) {
  const trail = [
    TRAIL_ROOT,
    ...breadcrumb.map((c) => ({ id: `${FOLDER_PREFIX}${c.id}`, label: c.name })),
  ];
  if (detailFile) trail.push({ id: `${FILE_PREFIX}${detailFile.id}`, label: detailFile.filename });
  return trail;
}

/** Open the view an address names: the top level, a folder, or a file. */
function followAddress(
  id: string,
  openFolder: (id: string) => void,
  openFile: (id: string) => void,
): void {
  if (id === TRAIL_ROOT.id) openFolder(ROOT);
  else if (id.startsWith(FOLDER_PREFIX)) openFolder(id.slice(FOLDER_PREFIX.length));
  else if (id.startsWith(FILE_PREFIX)) openFile(id.slice(FILE_PREFIX.length));
}

function lastName(breadcrumb: Crumb[], top = "this folder"): string {
  return breadcrumb[breadcrumb.length - 1]?.name ?? top;
}

/**
 * Files dragged from outside onto the view: `true` while they are over it, and
 * `onDrop` with them when let go. A drop the upload dialog's zone takes stops
 * there. Without `enabled` (a host that cannot take dropped files) a drop is
 * still swallowed, so the browser never navigates the frame to the file.
 */
function useViewDrop(enabled: boolean, onDrop: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (enabled) setDragging(true);
    };
    const leave = (e: DragEvent) => {
      // Leaving for a child fires too; only leaving the frame has no target.
      if (e.relatedTarget === null) setDragging(false);
    };
    // Any drop ends the drag, wherever it lands. Captured, because the
    // dialog's zone stops its drop before it bubbles here.
    const end = () => setDragging(false);
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (enabled && files.length > 0) dropRef.current(files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", end, true);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", end, true);
      window.removeEventListener("drop", drop);
    };
  }, [enabled]);

  return dragging;
}

function nameOf(id: string, folders: Folder[], files: FileEntry[]): string {
  return (
    folders.find((f) => f.id === id)?.name ??
    files.find((f) => f.id === id)?.filename ??
    "this item"
  );
}

function movedTo(f: OpenFile, target: string): OpenFile {
  return { ...f, folderId: target === ROOT ? null : target, folderPath: undefined };
}

function detailLocation(f: OpenFile, where: string): string {
  if (f.folderPath !== undefined) return f.folderPath;
  return f.folderId ? where : "";
}

function SelectionBar({
  count,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection">
      <span className="selection-count">{count} selected</span>
      <button type="button" className="btn-ghost" onClick={onMove}>
        Move to…
      </button>
      <button type="button" className="btn-danger" onClick={onDelete}>
        Delete
      </button>
      <button type="button" className="btn-link" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      <button type="button" className="error-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function Toast({ message }: { message: string | null }) {
  return message ? (
    <div className="toast" role="status">
      {message}
    </div>
  ) : null;
}

function LoadingRows() {
  return (
    <div className="loading-list">
      {["s1", "s2", "s3", "s4", "s5", "s6"].map((k) => (
        <div key={k} className="skel skel-row" />
      ))}
    </div>
  );
}

/**
 * The folders down to the one the reader is in. A search does not change where
 * the reader is, so this keeps the last breadcrumb a folder listing gave.
 */
function useBreadcrumb(result: ListResult | null, searching: boolean, folderId: string): Crumb[] {
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  useEffect(() => {
    if (result && !searching) setBreadcrumb(result.breadcrumb);
  }, [result, searching]);
  useEffect(() => {
    if (folderId === ROOT) setBreadcrumb([]);
  }, [folderId]);
  return breadcrumb;
}

/** What the agent is told the reader is looking at. */
function describeView({
  browse,
  where,
  total,
  detailFile,
  selected,
}: {
  browse: ReturnType<typeof useBrowseState>;
  where: string;
  total: number | undefined;
  detailFile: OpenFile | null;
  selected: ReadonlySet<string>;
}) {
  const state: Record<string, unknown> = {
    folderId: browse.inFolder ? browse.folderId : null,
    folderPath: where,
    total: total ?? null,
    selected: [...selected],
  };
  if (browse.query) state.query = browse.query;
  if (browse.hasFilter) {
    state.filters = { kinds: browse.kinds, source: browse.sourceKey, since: browse.since };
  }
  if (detailFile) state.openFileId = detailFile.id;

  const place = where || "the top level";
  let summary = `Browsing ${place} in Files`;
  if (detailFile) summary = `Viewing ${detailFile.filename} in Files`;
  else if (browse.searching) {
    const what = browse.query ? ` for "${browse.query}"` : "";
    const scope = browse.inFolder && browse.scoped ? ` in ${place}` : "";
    summary = `Searching Files${what}${scope}: ${total ?? "…"} matches`;
  }
  return { state, summary };
}

function EmptyState({
  searching,
  query,
  inFolder,
}: {
  searching: boolean;
  query: string;
  inFolder: boolean;
}) {
  let title = "No files yet";
  let desc = "Files from conversations, agents, and uploads appear here.";
  if (searching) {
    title = "Nothing matches";
    desc = query ? `No files or folders match “${query}”.` : "No files match these filters.";
  } else if (inFolder) {
    title = "This folder is empty";
    desc = "Upload files here, or move files in with Move to….";
  }
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <FolderIcon size={48} />
      </div>
      <div className="empty-state-title">{title}</div>
      <div className="empty-state-desc">{desc}</div>
    </div>
  );
}
