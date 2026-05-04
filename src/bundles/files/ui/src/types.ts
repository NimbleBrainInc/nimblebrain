// Wire shape of a file as returned by the platform's `files` source.
// Mirrors `src/files/types.ts:FileEntry` but kept local because the bundle
// UI talks to the server over MCP — coupling its types to server-side TS
// would defeat the protocol abstraction.
export interface FileEntry {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  tags: string[];
  source?: "chat" | "agent" | "app" | "manual";
  conversationId?: string | null;
  createdAt?: string;
  description?: string | null;
}

export interface ListResult {
  files: FileEntry[];
  totalCount: number;
}

export type FilterKey = "all" | "images" | "documents" | "data" | "fonts";

export interface TagCount {
  tag: string;
  count: number;
}
