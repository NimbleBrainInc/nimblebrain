/**
 * `list` and `search`: filter, sort, page and count one owner's files on the server, so a
 * filter, a search, and the counts beside them describe the same set however many files
 * there are (CONTRACT.md §5).
 *
 * `list` pages by an opaque cursor: the position after the last file of the page (its sort
 * value and id, the order's tie-break) and a digest of the query it belongs to. A file's
 * sort values never change (no tool renames a file or rewrites a body), so a file that
 * existed when the first page was read is reached exactly once by following the cursor.
 */

import { createHash } from "node:crypto";
import { folderNotFound, invalidInput } from "./contract.ts";
import {
  ancestry,
  type FolderIndex,
  folderPath,
  indexFolders,
  type ListedFolder,
  normalizeFolderId,
  ownerFiles,
  ownerFolders,
  subtreeIds,
  toListedFolder,
} from "./folders.ts";
import { type FileKind, fileKind } from "./mime.ts";
import type { FileRow, FolderRow, WorkspaceState } from "./store.ts";

export const FILE_KINDS: readonly FileKind[] = ["image", "document", "data", "font", "other"];
export const FILE_SOURCES = ["chat", "agent", "app", "manual"] as const;

export interface ListInput {
  folderId?: string;
  recursive?: boolean;
  query?: string;
  kinds?: FileKind[];
  sources?: string[];
  conversationId?: string;
  runId?: string;
  createdAfter?: string;
  createdBefore?: string;
  tags?: string[];
  mimeType?: string;
  sort?: "createdAt" | "filename" | "size";
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

export interface SearchInput {
  query: string;
  tags?: string[];
  mimeType?: string;
  limit?: number;
}

/** A file's public record: everything but the wall it is kept behind. */
export function fileRecord(row: FileRow, workspaceId: string): Record<string, unknown> {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    tags: [...row.tags],
    source: row.source,
    conversationId: row.conversationId,
    runId: row.runId,
    createdAt: row.createdAt,
    description: row.description,
    folderId: row.folderId,
    ownerId: row.ownerId,
    workspaceId,
  };
}

/** The folder a file is in, reading a folder that no longer exists as the top level. */
function effectiveFolder(index: FolderIndex, f: FileRow): string | null {
  return f.folderId && index.byId.has(f.folderId) ? f.folderId : null;
}

function matchesQuery(f: FileRow, query: string): boolean {
  return [f.filename, f.description ?? "", ...f.tags].join(" ").toLowerCase().includes(query);
}

type Facet = "kinds" | "sources";
interface Predicate {
  facet?: Facet;
  test: (f: FileRow) => boolean;
}

function placePredicate(input: ListInput, index: FolderIndex): Predicate | null {
  if (input.folderId === undefined) return null;
  const folder = normalizeFolderId(input.folderId);
  if (folder !== null && !index.byId.has(folder)) throw folderNotFound(input.folderId);
  if (!input.recursive) return { test: (f) => effectiveFolder(index, f) === folder };
  if (folder === null) return null;
  const ids = subtreeIds(index, folder);
  return { test: (f) => ids.has(effectiveFolder(index, f) ?? "") };
}

function nonEmpty<T>(values: T[] | undefined): values is T[] {
  return values !== undefined && values.length > 0;
}

function queryPredicate(input: ListInput): Predicate | null {
  const q = input.query?.trim().toLowerCase();
  return q ? { test: (f) => matchesQuery(f, q) } : null;
}

/** The filters that describe files, as opposed to where to look or the text query. */
const FILE_PREDICATES: Array<(input: ListInput) => Predicate | null> = [
  ({ kinds }) => {
    if (!nonEmpty(kinds)) return null;
    const set = new Set<FileKind>(kinds);
    return { facet: "kinds", test: (f) => set.has(fileKind(f.mimeType)) };
  },
  ({ sources }) => {
    if (!nonEmpty(sources)) return null;
    const set = new Set(sources);
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

function predicates(input: ListInput, index: FolderIndex): Predicate[] {
  return [
    placePredicate(input, index),
    queryPredicate(input),
    ...FILE_PREDICATES.map((build) => build(input)),
  ].filter((p): p is Predicate => p !== null);
}

type SortField = NonNullable<ListInput["sort"]>;

function sortValue(f: Pick<FileRow, "createdAt" | "filename" | "size">, sort: SortField) {
  return sort === "size" ? f.size : sort === "filename" ? f.filename : f.createdAt;
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Sort position: the field in the order's direction, then the id ascending. */
interface Position {
  value: string | number;
  id: string;
}

function comparePositions(a: Position, b: Position, order: "asc" | "desc"): number {
  const cmp = compareValues(a.value, b.value);
  if (cmp !== 0) return order === "asc" ? cmp : -cmp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether any filter that describes files rather than place or text is set. */
function hasFileOnlyFilter(input: ListInput): boolean {
  return FILE_PREDICATES.some((build) => build(input) !== null);
}

function countFacets(all: FileRow[], preds: Predicate[]) {
  const without = (facet: Facet) =>
    all.filter((f) => preds.every((p) => p.facet === facet || p.test(f)));
  const kinds = Object.fromEntries(FILE_KINDS.map((k) => [k, 0])) as Record<FileKind, number>;
  for (const f of without("kinds")) kinds[fileKind(f.mimeType)] += 1;
  const sources = Object.fromEntries(FILE_SOURCES.map((s) => [s, 0])) as Record<string, number>;
  for (const f of without("sources")) {
    if (Object.hasOwn(sources, f.source)) sources[f.source] = (sources[f.source] ?? 0) + 1;
  }
  return { kinds, sources };
}

function listFolders(
  input: ListInput,
  index: FolderIndex,
  folderId: string | null | undefined,
): FolderRow[] {
  if (hasFileOnlyFilter(input)) return [];
  const query = input.query?.trim().toLowerCase();
  if (!query) return folderId === undefined ? [] : (index.children.get(folderId) ?? []);
  const below = input.recursive && folderId ? subtreeIds(index, folderId) : null;
  const inScope = (f: FolderRow): boolean => {
    if (folderId === undefined || (input.recursive && folderId === null)) return true;
    const parent = f.parentId && index.byId.has(f.parentId) ? f.parentId : null;
    return below ? f.id !== folderId && below.has(parent ?? "") : parent === folderId;
  };
  return [...index.byId.values()].filter((f) => f.name.toLowerCase().includes(query) && inScope(f));
}

/** The digest a cursor carries: the query it pages, without the cursor and page size. */
function queryDigest(input: ListInput): string {
  const { cursor: _cursor, limit: _limit, ...query } = input;
  const canonical = JSON.stringify(query, Object.keys(query).sort());
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

function encodeCursor(digest: string, at: Position): string {
  return Buffer.from(JSON.stringify({ q: digest, v: at.value, i: at.id })).toString("base64url");
}

function decodeCursor(cursor: string, digest: string): Position {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw invalidInput("list", "`cursor` is not one this server issued");
  }
  const c = parsed as { q?: unknown; v?: unknown; i?: unknown } | null;
  if (
    !c ||
    typeof c.i !== "string" ||
    (typeof c.v !== "string" && typeof c.v !== "number") ||
    typeof c.q !== "string"
  ) {
    throw invalidInput("list", "`cursor` is not one this server issued");
  }
  if (c.q !== digest) {
    throw invalidInput(
      "list",
      "`cursor` belongs to a list with other filters or sort; pass it back with the same ones",
    );
  }
  return { value: c.v, id: c.i };
}

export function listFiles(
  state: WorkspaceState,
  workspaceId: string,
  ownerId: string,
  input: ListInput,
) {
  const digest = queryDigest(input);
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor, digest);
  const all = ownerFiles(state, ownerId);
  const index = indexFolders(ownerFolders(state, ownerId));
  const preds = predicates(input, index);
  const sort = input.sort ?? "createdAt";
  const order = input.order ?? (sort === "filename" ? "asc" : "desc");
  const position = (f: FileRow): Position => ({ value: sortValue(f, sort), id: f.id });
  const matches = all
    .filter((f) => preds.every((p) => p.test(f)))
    .sort((a, b) => comparePositions(position(a), position(b), order));
  const start = after
    ? matches.findIndex((f) => comparePositions(position(f), after, order) > 0)
    : 0;
  const from = start < 0 ? matches.length : start;
  const limit = input.limit ?? 20;
  const page = matches.slice(from, from + limit);
  const last = page[page.length - 1];
  const more = from + page.length < matches.length;
  const folderId = input.folderId === undefined ? undefined : normalizeFolderId(input.folderId);
  return {
    files: page.map((f) => ({
      ...fileRecord(f, workspaceId),
      folderId: effectiveFolder(index, f),
      folderPath: folderPath(index, effectiveFolder(index, f)),
    })),
    total: matches.length,
    folders: listFolders(input, index, folderId)
      .map((f): ListedFolder => toListedFolder(index, f))
      .sort((a, b) => a.name.localeCompare(b.name)),
    breadcrumb: ancestry(index, folderId ?? null).map((f) => ({ id: f.id, name: f.name })),
    facets: countFacets(all, preds),
    nextCursor: more && last ? encodeCursor(digest, position(last)) : null,
  };
}

export function searchFiles(
  state: WorkspaceState,
  workspaceId: string,
  ownerId: string,
  input: SearchInput,
) {
  const query = input.query.toLowerCase();
  const files = ownerFiles(state, ownerId)
    .filter((f) => !input.tags?.length || input.tags.every((t) => f.tags.includes(t)))
    .filter((f) => !input.mimeType || f.mimeType.startsWith(input.mimeType))
    .filter((f) => matchesQuery(f, query))
    .sort((a, b) =>
      comparePositions({ value: a.createdAt, id: a.id }, { value: b.createdAt, id: b.id }, "desc"),
    );
  return {
    files: files.slice(0, input.limit ?? 20).map((f) => fileRecord(f, workspaceId)),
    total: files.length,
  };
}
