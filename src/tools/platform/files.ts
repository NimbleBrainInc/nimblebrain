/**
 * Files platform source — in-process MCP server backing the workspace file
 * store. Files are persisted via a JSONL registry and on-disk binary
 * storage.
 *
 * Both this tool source and the chat multipart ingest path
 * (`src/api/handlers.ts::handleChat` / `handleChatStream`) share a single
 * `FileStore` implementation from `src/files/store.ts`. Storage identity —
 * directory layout, ID scheme, registry semantics — lives there. This
 * module only defines the tool schemas and adapts calls into the store.
 *
 * Tools (7): list, search, read, create, info, tag, delete
 * Resources: ui://files/browser (React SPA)
 * Placements: sidebar files link at priority 3
 */

import { join } from "node:path";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import { createFileStore, type FileStore } from "../../files/store.ts";
import type { FileEntry } from "../../files/types.ts";
import { fileIdToUri, uriToFileId } from "../../files/uri.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import {
  type DynamicResourceEntry,
  defineInProcessApp,
  type InProcessResource,
  type InProcessTool,
} from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { loadFilesUi } from "../platform-resources/files/browser.ts";
import {
  FilesCreateInput,
  FilesDeleteInput,
  FilesInfoInput,
  FilesListInput,
  FilesReadInput,
  FilesSearchInput,
  FilesTagInput,
} from "./schemas/files.ts";

// ---------------------------------------------------------------------------
// Tool handler helpers
// ---------------------------------------------------------------------------

interface ListInput {
  limit?: number;
  offset?: number;
  tags?: string[];
  mimeType?: string;
  sort?: "createdAt" | "filename" | "size";
}

function filterEntries(
  entries: FileEntry[],
  tags: string[] | undefined,
  mimeType: string | undefined,
): FileEntry[] {
  let out = entries;
  if (tags && tags.length > 0) {
    out = out.filter((f) => tags.every((t) => f.tags.includes(t)));
  }
  if (mimeType) {
    out = out.filter((f) => f.mimeType.startsWith(mimeType));
  }
  return out;
}

async function handleList(store: FileStore, args: ListInput): Promise<object> {
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const sort = args.sort ?? "createdAt";

  const all = await store.readRegistry();
  const files = filterEntries(all, args.tags, args.mimeType);

  if (sort === "createdAt") {
    files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } else if (sort === "filename") {
    files.sort((a, b) => a.filename.localeCompare(b.filename));
  } else if (sort === "size") {
    files.sort((a, b) => b.size - a.size);
  }

  return { files: files.slice(offset, offset + limit), total: files.length };
}

interface SearchInput {
  query: string;
  tags?: string[];
  mimeType?: string;
  limit?: number;
}

async function handleSearch(store: FileStore, args: SearchInput): Promise<object> {
  const limit = args.limit ?? 20;
  const query = args.query.toLowerCase();

  const all = await store.readRegistry();
  let files = filterEntries(all, args.tags, args.mimeType);

  files = files.filter((f) => {
    const searchable = [f.filename, f.description ?? "", ...f.tags].join(" ").toLowerCase();
    return searchable.includes(query);
  });

  files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { files: files.slice(0, limit), total: files.length };
}

async function handleRead(store: FileStore, args: { id: string }): Promise<object> {
  // `readFile` throws `File not found` if the registry entry is missing, so
  // a separate `findEntry` pre-check would just re-scan the registry.
  const read = await store.readFile(args.id);
  return {
    base64Data: read.data.toString("base64"),
    filename: read.filename,
    mimeType: read.mimeType,
    size: read.size,
  };
}

/**
 * Strict input shape for `files__create`. Mirrors the JSON Schema:
 * `manifest` holds the file metadata; `body` is the base64-encoded
 * content. Field names match `FileEntry` (camelCase) — no kebab/snake
 * acceptance.
 */
interface CreateInput {
  manifest: {
    filename: string;
    mimeType: string;
    tags?: string[];
    description?: string;
  };
  body: string;
}

async function handleCreate(store: FileStore, args: CreateInput): Promise<object> {
  // TODO: apply the same MIME allowlist as chat-multipart ingest
  // (`ALLOWED_MIMES` in `src/files/ingest.ts`). The tool currently accepts
  // any `mimeType` the LLM supplies; the chat path rejects anything
  // outside the allowlist. Changing the tool contract is fenced out of the
  // store-unification PR that introduced this comment — track separately.
  const { manifest, body } = args;
  const decoded = Buffer.from(body, "base64");
  const saved = await store.saveFile(decoded, manifest.filename, manifest.mimeType);
  const entry: FileEntry = {
    id: saved.id,
    filename: manifest.filename,
    mimeType: manifest.mimeType,
    size: saved.size,
    tags: manifest.tags ?? [],
    // The LLM invokes this tool; human-uploaded-via-UI is "manual",
    // chat-multipart is "chat", app-generated is "app".
    source: "agent",
    conversationId: null,
    createdAt: new Date().toISOString(),
    description: manifest.description ?? null,
  };
  await store.appendRegistry(entry);
  return { id: saved.id, filename: manifest.filename, size: saved.size };
}

async function handleInfo(store: FileStore, args: { id: string }): Promise<object> {
  const entry = await store.findEntry(args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }
  return entry;
}

interface TagInput {
  id: string;
  add?: string[];
  remove?: string[];
}

async function handleTag(store: FileStore, args: TagInput): Promise<object> {
  const entry = await store.findEntry(args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }

  const tagSet = new Set(entry.tags);
  if (args.add) for (const t of args.add) tagSet.add(t);
  if (args.remove) for (const t of args.remove) tagSet.delete(t);

  const newTags = Array.from(tagSet);
  const updated: FileEntry = { ...entry, tags: newTags };
  await store.appendRegistry(updated);

  return { id: args.id, tags: newTags };
}

async function handleDelete(store: FileStore, args: { id: string }): Promise<object> {
  const entry = await store.findEntry(args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }
  await store.deleteFile(args.id);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the "files" platform source — in-process MCP server. */
export function createFilesSource(runtime: Runtime, eventSink: EventSink): McpSource {
  function getStore(): FileStore {
    return createFileStore(join(runtime.getWorkspaceScopedDir(), "files"));
  }

  function ok(data: object): ToolResult {
    return { content: textContent(JSON.stringify(data, null, 2)), isError: false };
  }

  function fail(message: string): ToolResult {
    return { content: textContent(JSON.stringify({ error: message })), isError: true };
  }

  const tools: InProcessTool[] = [
    {
      name: "list",
      description:
        "List files in the workspace with pagination, filtering by tags or MIME type, and sorting.",
      inputSchema: FilesListInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return ok(await handleList(getStore(), input as unknown as ListInput));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "search",
      description:
        "Search files by keyword. Case-insensitive substring match on filename, description, and tags.",
      inputSchema: FilesSearchInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return ok(await handleSearch(getStore(), input as unknown as SearchInput));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "read",
      description: "Read a file's content by ID. Returns base64-encoded data along with metadata.",
      inputSchema: FilesReadInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return ok(await handleRead(getStore(), input as unknown as { id: string }));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "create",
      description:
        "Create a new file in the workspace. `manifest` is the file metadata; `body` is the base64-encoded content.",
      inputSchema: FilesCreateInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return ok(await handleCreate(getStore(), input as unknown as CreateInput));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "info",
      description: "Get file metadata by ID (no file content returned).",
      inputSchema: FilesInfoInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return ok(await handleInfo(getStore(), input as unknown as { id: string }));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "tag",
      description: "Add or remove tags on a file.",
      inputSchema: FilesTagInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return ok(await handleTag(getStore(), input as unknown as TagInput));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "delete",
      description:
        "Delete a file by ID. Removes the file from disk and marks it as deleted in the registry.",
      inputSchema: FilesDeleteInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return ok(await handleDelete(getStore(), input as unknown as { id: string }));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];

  const resources = new Map<string, InProcessResource>([
    ["ui://files/browser", { text: loadFilesUi, mimeType: "text/html" }],
  ]);

  // Workspace files are exposed as MCP resources at `files://<id>`. Any
  // MCP client (the agent loop, an iframe app via the bridge, an external
  // tool like Claude Code) can list them via `resources/list` and fetch
  // bytes via `resources/read`. The platform itself uses these URIs in
  // the `resource_link` content blocks it persists in user messages —
  // see `src/files/ingest.ts`.
  const listResourcesFn = async (): Promise<DynamicResourceEntry[]> => {
    const all = await getStore().readRegistry();
    return all.map((entry) => ({
      uri: fileIdToUri(entry.id),
      name: entry.filename,
      mimeType: entry.mimeType,
    }));
  };

  const resourceHandler = async (uri: string): Promise<InProcessResource | null> => {
    const id = uriToFileId(uri);
    if (!id) return null;
    try {
      const read = await getStore().readFile(id);
      // Text MIMEs return as `text` (utf-8 decoded); everything else returns
      // as `blob` (base64 on the wire). This matches MCP's TextResourceContents
      // / BlobResourceContents split — clients that want a string get one
      // without round-tripping through base64.
      if (isTextMime(read.mimeType)) {
        return { text: read.data.toString("utf-8"), mimeType: read.mimeType };
      }
      return { blob: new Uint8Array(read.data), mimeType: read.mimeType };
    } catch {
      // Not found or tombstoned — surface as not-found to the client.
      return null;
    }
  };

  return defineInProcessApp(
    {
      name: "files",
      version: "1.0.0",
      tools,
      resources,
      listResources: listResourcesFn,
      resourceHandler,
      placements: [
        {
          slot: "sidebar",
          resourceUri: "ui://files/browser",
          route: "@nimblebraininc/files",
          label: "Files",
          icon: "folder",
          priority: 3,
        },
      ],
    },
    eventSink,
  );
}

const TEXT_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
]);

function isTextMime(mimeType: string): boolean {
  const bare = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return bare.startsWith("text/") || TEXT_MIMES.has(bare);
}
