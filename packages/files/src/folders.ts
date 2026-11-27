/**
 * Folders in one owner's files. A folder is a record, and a file names its folder by
 * `folderId`; nothing moves on disk, so a rename or a move rewrites one record. `null` is
 * the top level, which has no record (the id `root` names it).
 *
 * Invariants every write here holds:
 * - A name is unique among its siblings, case-insensitively, so a path such as `Reports/Q3`
 *   resolves to one folder.
 * - A folder is never moved under itself or a descendant.
 * - A folder is deleted only when empty, so no delete removes more than the one record.
 */

import { conflict, fileNotFound, folderNotFound, invalidInput } from "./contract.ts";
import { type FileRow, type FolderRow, mintId, type WorkspaceState } from "./store.ts";

export const ROOT_FOLDER_ID = "root";

/** One owner's folders, indexed for path and ancestry lookups. */
export interface FolderIndex {
  byId: Map<string, FolderRow>;
  /** Child folders by parent id; the top level is keyed by `null`. */
  children: Map<string | null, FolderRow[]>;
}

export function ownerFolders(state: WorkspaceState, ownerId: string): FolderRow[] {
  return Object.values(state.folders).filter((f) => f.ownerId === ownerId);
}

export function ownerFiles(state: WorkspaceState, ownerId: string): FileRow[] {
  return Object.values(state.files).filter((f) => f.ownerId === ownerId);
}

export function indexFolders(folders: FolderRow[]): FolderIndex {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const children = new Map<string | null, FolderRow[]>();
  for (const f of folders) {
    const parent = f.parentId && byId.has(f.parentId) ? f.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(f);
    children.set(parent, list);
  }
  return { byId, children };
}

/** `"root"` and absent mean the top level, `null`; any other id passes through. */
export function normalizeFolderId(id: string | null | undefined): string | null {
  return !id || id === ROOT_FOLDER_ID ? null : id;
}

/** The folder and its ancestors, top first. Empty for the top level or an unknown id. */
export function ancestry(index: FolderIndex, id: string | null): FolderRow[] {
  const out: FolderRow[] = [];
  const seen = new Set<string>();
  let cur = id ? index.byId.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? index.byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** The '/'-separated path of a folder; "" for the top level. */
export function folderPath(index: FolderIndex, id: string | null | undefined): string {
  return ancestry(index, id ?? null)
    .map((f) => f.name)
    .join("/");
}

/** The folder's id and every folder below it. */
export function subtreeIds(index: FolderIndex, id: string): Set<string> {
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    for (const child of index.children.get(next) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return out;
}

export interface ListedFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  path: string;
}

export function toListedFolder(index: FolderIndex, f: FolderRow): ListedFolder {
  const parentId = f.parentId && index.byId.has(f.parentId) ? f.parentId : null;
  return {
    id: f.id,
    name: f.name,
    parentId,
    createdAt: f.createdAt,
    path: folderPath(index, f.id),
  };
}

function siblingNamed(
  index: FolderIndex,
  parentId: string | null,
  name: string,
): FolderRow | undefined {
  const lower = name.toLowerCase();
  return (index.children.get(parentId) ?? []).find((f) => f.name.toLowerCase() === lower);
}

function cleanName(tool: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) {
    throw invalidInput(tool, `"${name}" is not a folder name`);
  }
  return trimmed;
}

function requireFolder(index: FolderIndex, id: string | null): void {
  if (id !== null && !index.byId.has(id)) throw folderNotFound(id);
}

function addFolder(
  state: WorkspaceState,
  index: FolderIndex,
  ownerId: string,
  name: string,
  parentId: string | null,
  now: string,
): FolderRow {
  const row: FolderRow = { id: mintId("fd"), ownerId, name, parentId, createdAt: now };
  state.folders[row.id] = row;
  index.byId.set(row.id, row);
  index.children.set(parentId, [...(index.children.get(parentId) ?? []), row]);
  return row;
}

export function createFolder(
  state: WorkspaceState,
  ownerId: string,
  input: { name: string; parentId?: string },
  now: string,
): ListedFolder {
  const index = indexFolders(ownerFolders(state, ownerId));
  const parentId = normalizeFolderId(input.parentId);
  requireFolder(index, parentId);
  const name = cleanName("create_folder", input.name);
  if (siblingNamed(index, parentId, name)) {
    throw conflict(`a folder named "${name}" already exists there`);
  }
  return toListedFolder(index, addFolder(state, index, ownerId, name, parentId, now));
}

export function updateFolder(
  state: WorkspaceState,
  ownerId: string,
  input: { id: string; name?: string; parentId?: string },
): ListedFolder {
  const index = indexFolders(ownerFolders(state, ownerId));
  const existing = index.byId.get(input.id);
  if (!existing) throw folderNotFound(input.id);
  const name = input.name === undefined ? existing.name : cleanName("update_folder", input.name);
  const parentId =
    input.parentId === undefined ? existing.parentId : normalizeFolderId(input.parentId);
  requireFolder(index, parentId);
  if (parentId !== null && subtreeIds(index, existing.id).has(parentId)) {
    throw conflict("a folder cannot be moved into itself or a folder inside it");
  }
  const clash = siblingNamed(index, parentId, name);
  if (clash && clash.id !== existing.id) {
    throw conflict(`a folder named "${name}" already exists there`);
  }
  const updated: FolderRow = { ...existing, name, parentId };
  state.folders[updated.id] = updated;
  index.byId.set(updated.id, updated);
  return toListedFolder(index, updated);
}

/** Delete an empty folder. A folder holding anything is a conflict, naming what it holds. */
export function deleteFolder(state: WorkspaceState, ownerId: string, id: string): void {
  const index = indexFolders(ownerFolders(state, ownerId));
  const existing = index.byId.get(id);
  if (!existing) throw folderNotFound(id);
  const fileCount = ownerFiles(state, ownerId).filter((f) => f.folderId === id).length;
  const folderCount = (index.children.get(id) ?? []).length;
  if (fileCount > 0 || folderCount > 0) {
    const parts: string[] = [];
    if (fileCount > 0) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
    if (folderCount > 0) parts.push(`${folderCount} folder${folderCount === 1 ? "" : "s"}`);
    throw conflict(
      `"${existing.name}" is not empty: it holds ${parts.join(" and ")}. Move or delete them first.`,
    );
  }
  delete state.folders[id];
}

/**
 * The segments of a '/'-separated folder path, or a refusal naming `tool` for a segment that
 * is empty or not a folder name. "" is the top level.
 */
export function pathSegments(tool: string, path: string): string[] {
  if (path === "") return [];
  return path.split("/").map((segment) => {
    if (segment.trim() === "") {
      throw invalidInput(tool, `the folder path "${path}" has an empty segment`);
    }
    return cleanName(tool, segment);
  });
}

/**
 * The folder a path names, creating each missing level. Matching is case-insensitive, as
 * sibling uniqueness is. `segments` come from {@link pathSegments}.
 */
export function ensureFolderPath(
  state: WorkspaceState,
  ownerId: string,
  segments: string[],
  now: string,
): string | null {
  if (segments.length === 0) return null;
  const index = indexFolders(ownerFolders(state, ownerId));
  let parentId: string | null = null;
  for (const name of segments) {
    const found = siblingNamed(index, parentId, name);
    parentId = found ? found.id : addFolder(state, index, ownerId, name, parentId, now).id;
  }
  return parentId;
}

/** Put files in a folder. Every id must name one of the owner's files; none moves otherwise. */
export function moveFiles(
  state: WorkspaceState,
  ownerId: string,
  ids: string[],
  folderId: string,
): string | null {
  const target = normalizeFolderId(folderId);
  requireFolder(indexFolders(ownerFolders(state, ownerId)), target);
  const missing = ids.filter((id) => state.files[id]?.ownerId !== ownerId);
  if (missing.length > 0) throw fileNotFound(missing.join(", "));
  for (const id of new Set(ids)) {
    const row = state.files[id] as FileRow;
    state.files[id] = { ...row, folderId: target };
  }
  return target;
}
