// Wire shapes of the files contract's public tools
// (`schemas/contracts/files/v1/contract.json`), kept local because the screen
// talks to its server over MCP.

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
  /** The cursor for the next page; null on the last. */
  nextCursor: string | null;
}

export type SortField = "createdAt" | "filename" | "size";
export type SortOrder = "asc" | "desc";

/** The id `folderId` takes for the top level. */
export const ROOT = "root";
