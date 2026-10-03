/**
 * `files__list`: filter, sort, page, and count one owner's files, all on the
 * server, so a filter, a search, and the counts beside them describe the same
 * set however many files there are.
 */

import type { FileStore } from "../../files/store.ts";
import type { FileEntry, FolderEntry } from "../../files/types.ts";
import {
  FILE_KINDS,
  FILE_SOURCES,
  type FileKind,
  type FileSource,
  type FilesListInput,
  type FilesListOutput,
} from "../schemas/files.ts";
import {
  ancestry,
  type FolderIndex,
  folderPath,
  indexFolders,
  normalizeFolderId,
  subtreeIds,
  toListedFolder,
} from "./folders.ts";

const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/rtf",
  "text/plain",
  "text/markdown",
  "text/html",
]);

const DATA_TYPES = new Set([
  "text/csv",
  "application/json",
  "application/yaml",
  "application/xml",
  "text/xml",
]);

/** The coarse kind of a MIME type, for filtering and the counts beside the filter. */
export function fileKind(mimeType: string): FileKind {
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("font/")) return "font";
  if (DATA_TYPES.has(mime) || mime.includes("spreadsheet") || mime.endsWith("+json")) {
    return "data";
  }
  if (
    DOCUMENT_TYPES.has(mime) ||
    mime.includes("wordprocessing") ||
    mime.includes("presentation") ||
    mime.includes("opendocument.text")
  ) {
    return "document";
  }
  return "other";
}

/** The folder a file is in, reading a folder that no longer exists as the top level. */
function effectiveFolder(index: FolderIndex, f: FileEntry): string | null {
  return f.folderId && index.byId.has(f.folderId) ? f.folderId : null;
}

function matchesQuery(f: FileEntry, query: string): boolean {
  return [f.filename, f.description ?? "", ...f.tags].join(" ").toLowerCase().includes(query);
}

type Facet = "kinds" | "sources";
interface Predicate {
  facet?: Facet;
  test: (f: FileEntry) => boolean;
}

/** Where to look: one folder, a folder and everything below it, or everywhere. */
function placePredicate(input: FilesListInput, index: FolderIndex): Predicate | null {
  if (input.folderId === undefined) return null;
  const folder = normalizeFolderId(input.folderId);
  if (folder !== null && !index.byId.has(folder)) {
    throw new Error(`Folder not found: ${input.folderId}`);
  }
  if (!input.recursive) return { test: (f) => effectiveFolder(index, f) === folder };
  if (folder === null) return null;
  const ids = subtreeIds(index, folder);
  return { test: (f) => ids.has(effectiveFolder(index, f) ?? "") };
}

function nonEmpty<T>(values: T[] | undefined): values is T[] {
  return values !== undefined && values.length > 0;
}

function queryPredicate(input: FilesListInput): Predicate | null {
  const q = input.query?.trim().toLowerCase();
  return q ? { test: (f) => matchesQuery(f, q) } : null;
}

/**
 * The filters that describe files, as opposed to where to look or the text
 * query, which also match folders. Each builds its predicate only when set.
 */
const FILE_PREDICATES: Array<(input: FilesListInput) => Predicate | null> = [
  ({ kinds }) => {
    if (!nonEmpty(kinds)) return null;
    const set = new Set<FileKind>(kinds);
    return { facet: "kinds", test: (f) => set.has(fileKind(f.mimeType)) };
  },
  ({ sources }) => {
    if (!nonEmpty(sources)) return null;
    const set = new Set<FileSource>(sources);
    return { facet: "sources", test: (f) => set.has(f.source) };
  },
  ({ conversationId: id }) => (id ? { test: (f) => f.conversationId === id } : null),
  ({ runId: id }) => (id ? { test: (f) => f.runId === id } : null),
  ({ createdAfter }) => {
    if (!createdAfter) return null;
    const after = Date.parse(createdAfter);
    return { test: (f) => Date.parse(f.createdAt) >= after };
  },
  ({ createdBefore }) => {
    if (!createdBefore) return null;
    const before = Date.parse(createdBefore);
    return { test: (f) => Date.parse(f.createdAt) < before };
  },
  ({ tags }) => (nonEmpty(tags) ? { test: (f) => tags.every((t) => f.tags.includes(t)) } : null),
  ({ mimeType: prefix }) => (prefix ? { test: (f) => f.mimeType.startsWith(prefix) } : null),
];

function predicates(input: FilesListInput, index: FolderIndex): Predicate[] {
  return [
    placePredicate(input, index),
    queryPredicate(input),
    ...FILE_PREDICATES.map((build) => build(input)),
  ].filter((p): p is Predicate => p !== null);
}

function compareFiles(
  sort: NonNullable<FilesListInput["sort"]>,
  order: "asc" | "desc",
): (a: FileEntry, b: FileEntry) => number {
  const sign = order === "asc" ? 1 : -1;
  return (a, b) => {
    let cmp = 0;
    if (sort === "filename") cmp = a.filename.localeCompare(b.filename);
    else if (sort === "size") cmp = a.size - b.size;
    else cmp = a.createdAt.localeCompare(b.createdAt);
    // Ties break on id so a page boundary never shows a file twice or not at all.
    return sign * cmp || a.id.localeCompare(b.id);
  };
}

/** Whether any filter that describes files rather than place or text is set. */
function hasFileOnlyFilter(input: FilesListInput): boolean {
  return FILE_PREDICATES.some((build) => build(input) !== null);
}

/** Matches per kind and per source, each counted with every filter but its own. */
function countFacets(all: FileEntry[], preds: Predicate[]): FilesListOutput["facets"] {
  const without = (facet: Facet) =>
    all.filter((f) => preds.every((p) => p.facet === facet || p.test(f)));
  const kinds = Object.fromEntries(FILE_KINDS.map((k) => [k, 0])) as Record<FileKind, number>;
  for (const f of without("kinds")) kinds[fileKind(f.mimeType)] += 1;
  const sources = Object.fromEntries(FILE_SOURCES.map((s) => [s, 0])) as Record<FileSource, number>;
  for (const f of without("sources")) sources[f.source] += 1;
  return { kinds, sources };
}

/**
 * The folders a listing shows: with a query, those whose name matches, inside
 * the folder (or below it when recursive, or anywhere without one); without a
 * query, the folder's children. None when a file-only filter is set.
 */
function listFolders(
  input: FilesListInput,
  index: FolderIndex,
  folderId: string | null | undefined,
): FolderEntry[] {
  if (hasFileOnlyFilter(input)) return [];
  const query = input.query?.trim().toLowerCase();
  if (!query) return folderId === undefined ? [] : (index.children.get(folderId) ?? []);

  const below = input.recursive && folderId ? subtreeIds(index, folderId) : null;
  const inScope = (f: FolderEntry): boolean => {
    if (folderId === undefined) return true;
    const parent = f.parentId && index.byId.has(f.parentId) ? f.parentId : null;
    return below ? f.id !== folderId && below.has(parent ?? "") : parent === folderId;
  };
  return [...index.byId.values()].filter((f) => f.name.toLowerCase().includes(query) && inScope(f));
}

export async function listFiles(store: FileStore, input: FilesListInput): Promise<FilesListOutput> {
  const [all, folders] = await Promise.all([store.readRegistry(), store.readFolders()]);
  const index = indexFolders(folders);
  const preds = predicates(input, index);
  const matches = all.filter((f) => preds.every((p) => p.test(f)));

  const sort = input.sort ?? "createdAt";
  matches.sort(compareFiles(sort, input.order ?? (sort === "filename" ? "asc" : "desc")));
  const offset = input.offset ?? 0;
  const page = matches.slice(offset, offset + (input.limit ?? 20));
  const folderId = input.folderId === undefined ? undefined : normalizeFolderId(input.folderId);

  return {
    files: page.map((f) => ({ ...f, folderPath: folderPath(index, effectiveFolder(index, f)) })),
    total: matches.length,
    folders: listFolders(input, index, folderId)
      .map((f) => toListedFolder(index, f))
      .sort((a, b) => a.name.localeCompare(b.name)),
    breadcrumb: ancestry(index, folderId ?? null).map((f) => ({ id: f.id, name: f.name })),
    facets: countFacets(all, preds),
  };
}
