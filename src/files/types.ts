/**
 * A file's record, as the files contract answers it (`$defs` file record,
 * `contracts/files/CONTRACT.md` §5). Open: a later minor may add fields.
 */
export interface FileRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  tags: string[];
  /** Known values: `chat`, `agent`, `app`, `manual`. */
  source: string;
  conversationId: string | null;
  runId?: string | null;
  createdAt: string;
  description: string | null;
  folderId?: string | null;
  ownerId?: string;
  workspaceId?: string;
}

/** Reference to a file attached to a chat message, stored in the message's metadata. */
export interface FileReference {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Whether the message carries the file's text. */
  extracted: boolean;
}

/**
 * A content part for the LLM message.
 *
 * Text and MCP `resource_link` only: an attachment's body stays with the files
 * plugin and the message carries its URI. The runtime rehydrates supported
 * resource links into AI SDK V4 `file` parts at the `model.doStream` boundary;
 * unsupported ones reach the model as text references.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; mimeType: string; name: string };

/** Limits the runtime applies when it takes files in and puts their text in a prompt. */
export interface FileConfig {
  maxFileSize: number;
  maxTotalSize: number;
  maxFilesPerMessage: number;
  /** The `maxBytes` the runtime passes to the plugin's `read` (at most 1 MiB, the contract's bound). */
  maxExtractedTextSize: number;
}

export const DEFAULT_FILE_CONFIG: FileConfig = {
  maxFileSize: 26_214_400,
  maxTotalSize: 104_857_600,
  maxFilesPerMessage: 10,
  maxExtractedTextSize: 204_800,
};

/** The most text the files contract's `read` answers (CONTRACT.md §7). */
export const READ_TEXT_BOUND = 1_048_576;
