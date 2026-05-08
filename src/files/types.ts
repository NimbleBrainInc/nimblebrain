/** Workspace file entry stored in registry.jsonl */
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
 * runtime rehydrates image resource_links into AI SDK V3 `file` parts at
 * the `model.doStream` boundary; non-image resource_links are surfaced
 * to the model as text references.
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
