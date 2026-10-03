import { formatSize, relativeTime, sourceLabel } from "./format";
import { FileTypeIcon, FolderIcon } from "./icons";
import type { Folder, ListedFile, SortField, SortOrder } from "./types";

interface Props {
  folders: Folder[];
  files: ListedFile[];
  /** Show each row's folder, for results gathered from more than one folder. */
  showLocation: boolean;
  sort: SortField;
  order: SortOrder;
  onSort: (field: SortField) => void;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string, range: boolean) => void;
  onToggleAll: () => void;
  onOpenFolder: (id: string) => void;
  onOpenFile: (file: ListedFile) => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
}

export function FileList(props: Props) {
  const rowCount = props.folders.length + props.files.length;
  const allSelected = rowCount > 0 && props.selected.size === rowCount;

  return (
    <div className="file-list">
      <div className="list-head">
        <span className="col-check">
          <input
            type="checkbox"
            aria-label="Select all shown"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = props.selected.size > 0 && !allSelected;
            }}
            onChange={props.onToggleAll}
          />
        </span>
        <SortHeader field="filename" label="Name" className="col-name" {...props} />
        {props.showLocation && <span className="col-location">Folder</span>}
        <span className="col-source">Source</span>
        <SortHeader field="size" label="Size" className="col-size" {...props} />
        <SortHeader field="createdAt" label="Created" className="col-date" {...props} />
      </div>

      {props.folders.map((folder) => (
        <div
          key={folder.id}
          className={`list-row folder-row${props.selected.has(folder.id) ? " selected" : ""}`}
        >
          <span className="col-check">
            <input
              type="checkbox"
              aria-label={`Select ${folder.name}`}
              checked={props.selected.has(folder.id)}
              onChange={noop}
              onClick={(e) => props.onToggleSelect(folder.id, e.shiftKey)}
            />
          </span>
          <button
            type="button"
            className="col-name row-open"
            onClick={() => props.onOpenFolder(folder.id)}
          >
            <span className="row-icon folder-icon">
              <FolderIcon size={18} />
            </span>
            <span className="row-name">{folder.name}</span>
          </button>
          {props.showLocation && (
            <span className="col-location">
              <LocationLink path={parentPath(folder.path)} id={folder.parentId} {...props} />
            </span>
          )}
          <span className="col-source" />
          <span className="col-size row-actions">
            <button
              type="button"
              className="row-action"
              onClick={() => props.onRenameFolder(folder)}
            >
              Rename
            </button>
            <button
              type="button"
              className="row-action"
              onClick={() => props.onDeleteFolder(folder)}
            >
              Delete
            </button>
          </span>
          <span className="col-date">{relativeTime(folder.createdAt)}</span>
        </div>
      ))}

      {props.files.map((file) => (
        <div key={file.id} className={`list-row${props.selected.has(file.id) ? " selected" : ""}`}>
          <span className="col-check">
            <input
              type="checkbox"
              aria-label={`Select ${file.filename}`}
              checked={props.selected.has(file.id)}
              onChange={noop}
              onClick={(e) => props.onToggleSelect(file.id, e.shiftKey)}
            />
          </span>
          <button
            type="button"
            className="col-name row-open"
            onClick={() => props.onOpenFile(file)}
            title={file.description ?? file.filename}
          >
            <span className="row-icon">
              <FileTypeIcon mimeType={file.mimeType} size={18} />
            </span>
            <span className="row-name">{file.filename}</span>
          </button>
          {props.showLocation && (
            <span className="col-location">
              <LocationLink path={file.folderPath} id={file.folderId ?? null} {...props} />
            </span>
          )}
          <span className="col-source">{sourceLabel(file.source)}</span>
          <span className="col-size">{formatSize(file.size || 0)}</span>
          <span className="col-date" title={file.createdAt}>
            {relativeTime(file.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Selection runs through `onClick`, which carries Shift for a range; the change is already handled. */
function noop(): void {}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function LocationLink({
  path,
  id,
  onOpenFolder,
}: {
  path: string;
  id: string | null;
  onOpenFolder: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="location-link"
      onClick={() => onOpenFolder(id ?? "root")}
      title={path ? `Open ${path}` : "Open the top level"}
    >
      {path || "Files"}
    </button>
  );
}

function SortHeader({
  field,
  label,
  className,
  sort,
  order,
  onSort,
}: {
  field: SortField;
  label: string;
  className: string;
  sort: SortField;
  order: SortOrder;
  onSort: (field: SortField) => void;
}) {
  const active = sort === field;
  return (
    <span className={className}>
      <button
        type="button"
        className={`sort-btn${active ? " active" : ""}`}
        onClick={() => onSort(field)}
      >
        {label}
        {active && <span aria-hidden>{order === "asc" ? " ↑" : " ↓"}</span>}
      </button>
    </span>
  );
}
