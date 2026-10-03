// Wire shapes of the platform's `files` source. They mirror
// `src/platform/schemas/files.ts` but are kept local because the app UI talks
// to the server over MCP — coupling its types to server-side TS would defeat
// the protocol abstraction.

export type FileSource = "chat" | "agent" | "app" | "manual";
export type FileKind = "image" | "document" | "data" | "font" | "other";

export interface FileEntry {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  tags: string[];
  source?: FileSource;
  conversationId?: string | null;
  runId?: string | null;
  createdAt?: string;
  description?: string | null;
  folderId?: string | null;
}

/** A listed file, with its folder's path ("" at the top level). */
export interface ListedFile extends FileEntry {
  folderPath: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  /** '/'-separated path, the folder's own name last. */
  path: string;
}

export interface Crumb {
  id: string;
  name: string;
}

export interface ListResult {
  files: ListedFile[];
  total: number;
  folders: Folder[];
  breadcrumb: Crumb[];
  facets: {
    kinds: Record<FileKind, number>;
    sources: Record<FileSource, number>;
  };
}

export type SortField = "createdAt" | "filename" | "size";
export type SortOrder = "asc" | "desc";

/** The id `folderId` takes for the top level. */
export const ROOT = "root";
