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

/** A content part for the LLM message */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: Uint8Array; mimeType: string };

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
