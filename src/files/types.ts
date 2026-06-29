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

/** File entry in the workspace registry (`workspaces/<wsId>/files/registry.jsonl`). */
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
  /**
   * Denormalised owner of the file. The store is rooted at the owner partition
   * (`workspaces/<wsId>/files/<ownerId>/`), so the DIRECTORY is the authority —
   * this field is a convenience the migration stamps for audit / future
   * cross-owner views. Absent on entries created without it.
   */
  ownerId?: string;
  /**
   * Denormalised workspace the file lives in. Stored under
   * `workspaces/<workspaceId>/files/<ownerId>/`, so the path is authoritative
   * and this field is the convenience. Absent on legacy/identity-era records.
   */
  workspaceId?: string;
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
