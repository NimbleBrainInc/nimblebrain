/**
 * Folders in one owner's file partition.
 *
 * A folder is a record in `folders.jsonl` (`FolderEntry`), and a file names its
 * folder by `FileEntry.folderId`. Nothing on disk moves: the bytes stay flat, so
 * a rename or a move rewrites one record. Absent or `null` means the top level,
 * which has no record of its own.
 *
 * Invariants every write here holds:
 * - A name is unique among its siblings, case-insensitively, so a path such as
 *   `Reports/Q3` resolves to one folder.
 * - A folder is never moved under itself or a descendant.
 * - A folder is deleted only when empty (no live file or folder inside it), so
 *   no delete removes more than the one record it names.
 */

import { type FileStore, generateFolderId } from "../../files/store.ts";
import type { FileEntry, FolderEntry } from "../../files/types.ts";
import { type ListedFolder, ROOT_FOLDER_ID } from "../schemas/files.ts";

/** The live folders of one partition, indexed for path and ancestry lookups. */
export interface FolderIndex {
  byId: Map<string, FolderEntry>;
  /** Child folders by parent id; the top level is keyed by `null`. */
  children: Map<string | null, FolderEntry[]>;
}

export function indexFolders(folders: FolderEntry[]): FolderIndex {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const children = new Map<string | null, FolderEntry[]>();
  for (const f of folders) {
    // A folder whose parent is gone reads as top level rather than vanishing.
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
export function ancestry(index: FolderIndex, id: string | null): FolderEntry[] {
  const out: FolderEntry[] = [];
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

export function toListedFolder(index: FolderIndex, f: FolderEntry): ListedFolder {
  return { ...f, path: folderPath(index, f.id) };
}

function siblingNamed(
  index: FolderIndex,
  parentId: string | null,
  name: string,
): FolderEntry | undefined {
  const lower = name.toLowerCase();
  return (index.children.get(parentId) ?? []).find((f) => f.name.toLowerCase() === lower);
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid folder name: "${name}"`);
  }
  if (/[/\\]/.test(trimmed)) {
    throw new Error(`A folder name cannot contain '/' or '\\': "${name}"`);
  }
  return trimmed;
}

function requireFolder(index: FolderIndex, id: string | null): void {
  if (id !== null && !index.byId.has(id)) throw new Error(`Folder not found: ${id}`);
}

export async function createFolder(
  store: FileStore,
  input: { name: string; parentId?: string },
): Promise<ListedFolder> {
  const index = indexFolders(await store.readFolders());
  const parentId = normalizeFolderId(input.parentId);
  requireFolder(index, parentId);
  const name = cleanName(input.name);
  if (siblingNamed(index, parentId, name)) {
    throw new Error(`A folder named "${name}" already exists there`);
  }
  const entry: FolderEntry = {
    id: generateFolderId(),
    name,
    parentId,
    createdAt: new Date().toISOString(),
  };
  await store.appendFolder(entry);
  index.byId.set(entry.id, entry);
  return toListedFolder(index, entry);
}

export async function updateFolder(
  store: FileStore,
  input: { id: string; name?: string; parentId?: string },
): Promise<ListedFolder> {
  const index = indexFolders(await store.readFolders());
  const existing = index.byId.get(input.id);
  if (!existing) throw new Error(`Folder not found: ${input.id}`);

  const name = input.name === undefined ? existing.name : cleanName(input.name);
  const parentId =
    input.parentId === undefined ? existing.parentId : normalizeFolderId(input.parentId);
  requireFolder(index, parentId);
  if (parentId !== null && subtreeIds(index, existing.id).has(parentId)) {
    throw new Error("A folder cannot be moved into itself or a folder inside it");
  }
  const clash = siblingNamed(index, parentId, name);
  if (clash && clash.id !== existing.id) {
    throw new Error(`A folder named "${name}" already exists there`);
  }

  const updated: FolderEntry = { ...existing, name, parentId };
  await store.appendFolder(updated);
  index.byId.set(updated.id, updated);
  return toListedFolder(index, updated);
}

/** Delete an empty folder. A folder holding anything is refused, naming what it holds. */
export async function deleteFolder(store: FileStore, id: string): Promise<void> {
  const [folders, files] = await Promise.all([store.readFolders(), store.readRegistry()]);
  const index = indexFolders(folders);
  const existing = index.byId.get(id);
  if (!existing) throw new Error(`Folder not found: ${id}`);

  const fileCount = files.filter((f) => f.folderId === id).length;
  const folderCount = (index.children.get(id) ?? []).length;
  if (fileCount > 0 || folderCount > 0) {
    const parts: string[] = [];
    if (fileCount > 0) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
    if (folderCount > 0) parts.push(`${folderCount} folder${folderCount === 1 ? "" : "s"}`);
    throw new Error(
      `"${existing.name}" is not empty: it holds ${parts.join(" and ")}. Move or delete them first.`,
    );
  }
  await store.appendFolder({ ...existing, deleted: true, deletedAt: new Date().toISOString() });
}

/**
 * Resolve a '/'-separated folder path to a folder id, creating each missing
 * level. Matching is case-insensitive, as sibling uniqueness is. An empty path
 * is the top level.
 */
export async function ensureFolderPath(store: FileStore, path: string): Promise<string | null> {
  const segments = path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const index = indexFolders(await store.readFolders());
  let parentId: string | null = null;
  for (const segment of segments) {
    const name = cleanName(segment);
    const found = siblingNamed(index, parentId, name);
    if (found) {
      parentId = found.id;
      continue;
    }
    const entry: FolderEntry = {
      id: generateFolderId(),
      name,
      parentId,
      createdAt: new Date().toISOString(),
    };
    await store.appendFolder(entry);
    index.byId.set(entry.id, entry);
    index.children.set(parentId, [...(index.children.get(parentId) ?? []), entry]);
    parentId = entry.id;
  }
  return parentId;
}

/** Put files in a folder. Every id must name a live file; none moves otherwise. */
export async function moveFiles(
  store: FileStore,
  ids: string[],
  folderId: string,
): Promise<string | null> {
  const target = normalizeFolderId(folderId);
  const [folders, files] = await Promise.all([store.readFolders(), store.readRegistry()]);
  requireFolder(indexFolders(folders), target);

  const byId = new Map<string, FileEntry>(files.map((f) => [f.id, f]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`File not found: ${missing.join(", ")}`);

  for (const id of new Set(ids)) {
    const entry = byId.get(id) as FileEntry;
    if ((entry.folderId ?? null) === target) continue;
    await store.appendRegistry({ ...entry, folderId: target });
  }
  return target;
}
