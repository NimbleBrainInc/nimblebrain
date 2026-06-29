/**
 * Cached extracted-text sidecar for a stored file.
 *
 * Persisted next to the bytes (`${id}.extracted.json`) so derived text is
 * computed once per file and reused on every rehydration. Invalidated by
 * `maxSize` mismatch — if the runtime's `maxExtractedTextSize` changes,
 * the cache is regenerated on next read.
 */
export interface ExtractedTextSidecar {
  text: string;
  maxSize: number;
  truncated: boolean;
}

/**
 * A file entry, stored in registry.jsonl under the workspace it belongs to:
 * `workspaces/<wsId>/files/<ownerId>/` (see `src/files/paths.ts`). The path is
 * authoritative for `workspaceId` + `ownerId`; the fields are a denormalised
 * convenience the store backfills from the path on read.
 */
export interface FileEntry {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  tags: string[];
  source: "chat" | "agent" | "app" | "manual";
  conversationId: string | null;
  createdAt: string;
  description: string | null;
  /** The workspace this file lives in. Path-authoritative (§2.3). */
  workspaceId: string;
  /** The identity that owns it — the privacy principal. Path-authoritative (§2.3). */
  ownerId: string;
  /**
   * Who can see it within its workspace. Absent reads as `private` (fail-closed).
   * v1 is private-only; `shared` is reserved groundwork (no read path consults it
   * yet). Never crosses the workspace wall.
   */
  visibility?: "private" | "shared";
  deleted?: true;
  deletedAt?: string;
}

/** Reference to a workspace file, stored in conversation message metadata */
export interface FileReference {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  extracted: boolean;
}

/** Result of the file ingest pipeline */
export interface IngestResult {
  contentParts: ContentPart[];
  fileRefs: FileReference[];
  errors: string[];
}

/**
 * A content part for the LLM message.
 *
 * Text and MCP `resource_link` only — bytes for binary attachments are
 * persisted in the workspace `FileStore` and referenced by URI. The
 * runtime rehydrates supported resource_links into AI SDK V3 `file` parts
 * at the `model.doStream` boundary; unsupported resource_links are
 * surfaced to the model as text references.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; mimeType: string; name: string };

/** Config for file operations */
export interface FileConfig {
  maxFileSize: number;
  maxTotalSize: number;
  maxFilesPerMessage: number;
  maxExtractedTextSize: number;
}

export const DEFAULT_FILE_CONFIG: FileConfig = {
  maxFileSize: 26_214_400,
  maxTotalSize: 104_857_600,
  maxFilesPerMessage: 10,
  maxExtractedTextSize: 204_800,
};
