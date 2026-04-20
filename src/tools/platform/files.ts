/**
 * Files InlineSource — workspace file store backed by a JSONL registry and
 * on-disk binary storage.
 *
 * Both this tool source and the chat multipart ingest path
 * (`src/api/handlers.ts::handleChat` / `handleChatStream`) share a single
 * `FileStore` implementation from `src/files/store.ts`. Storage identity —
 * directory layout, ID scheme, registry semantics — lives there. This
 * module only defines the tool schemas and adapts calls into the store.
 *
 * Tools (7): list, search, read, create, info, tag, delete
 * Resources: files/browser (React SPA)
 * Placements: sidebar files link at priority 3
 */

import { join } from "node:path";
import { textContent } from "../../engine/content-helpers.ts";
import type { ToolResult } from "../../engine/types.ts";
import { createFileStore, type FileStore } from "../../files/store.ts";
import type { FileEntry } from "../../files/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { InlineSource, type InlineToolDef } from "../inline-source.ts";
import { FILES_BROWSER_HTML } from "../platform-resources/files/browser.ts";

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
  const entry = await store.findEntry(args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }
  const read = await store.readFile(args.id);
  return {
    base64Data: read.data.toString("base64"),
    filename: entry.filename,
    mimeType: entry.mimeType,
    size: entry.size,
  };
}

interface CreateInput {
  filename: string;
  base64_data: string;
  mime_type: string;
  tags?: string[];
  description?: string;
}

async function handleCreate(store: FileStore, args: CreateInput): Promise<object> {
  const decoded = Buffer.from(args.base64_data, "base64");
  const saved = await store.saveFile(decoded, args.filename, args.mime_type);
  const entry: FileEntry = {
    id: saved.id,
    filename: args.filename,
    mimeType: args.mime_type,
    size: saved.size,
    tags: args.tags ?? [],
    // The LLM invokes this tool; human-uploaded-via-UI is "manual",
    // chat-multipart is "chat", app-generated is "app".
    source: "agent",
    conversationId: null,
    createdAt: new Date().toISOString(),
    description: args.description ?? null,
  };
  await store.appendRegistry(entry);
  return { id: saved.id, filename: args.filename, size: saved.size };
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

/** Create the "files" InlineSource. */
export function createFilesSource(runtime: Runtime): InlineSource {
  function getStore(): FileStore {
    return createFileStore(join(runtime.getWorkspaceScopedDir(), "files"));
  }

  function ok(data: object): ToolResult {
    return { content: textContent(JSON.stringify(data, null, 2)), isError: false };
  }

  function fail(message: string): ToolResult {
    return { content: textContent(JSON.stringify({ error: message })), isError: true };
  }

  const tools: InlineToolDef[] = [
    {
      name: "list",
      description:
        "List files in the workspace with pagination, filtering by tags or MIME type, and sorting.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Max files to return. Default: 20.",
          },
          offset: {
            type: "number",
            description: "Number of files to skip. Default: 0.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags (files must have ALL specified tags).",
          },
          mimeType: {
            type: "string",
            description:
              "Filter by MIME type prefix (e.g. 'image/' matches image/png, image/jpeg).",
          },
          sort: {
            type: "string",
            enum: ["createdAt", "filename", "size"],
            description: 'Sort field. Default: "createdAt".',
          },
        },
      },
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
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags.",
          },
          mimeType: {
            type: "string",
            description: "Filter by MIME type prefix.",
          },
          limit: {
            type: "number",
            description: "Max results. Default: 20.",
          },
        },
        required: ["query"],
      },
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
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "File ID.",
          },
        },
        required: ["id"],
      },
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
      description: "Create a new file in the workspace. Provide base64-encoded data.",
      inputSchema: {
        type: "object" as const,
        properties: {
          filename: {
            type: "string",
            description: "Filename (e.g. 'logo.png').",
          },
          base64_data: {
            type: "string",
            description: "File content as base64-encoded string.",
          },
          mime_type: {
            type: "string",
            description: "MIME type (e.g. 'image/png').",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for categorization.",
          },
          description: {
            type: ["string", "null"],
            description: "Optional description of the file.",
          },
        },
        required: ["filename", "base64_data", "mime_type"],
      },
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
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "File ID.",
          },
        },
        required: ["id"],
      },
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
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "File ID.",
          },
          add: {
            type: "array",
            items: { type: "string" },
            description: "Tags to add.",
          },
          remove: {
            type: "array",
            items: { type: "string" },
            description: "Tags to remove.",
          },
        },
        required: ["id"],
      },
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
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "File ID.",
          },
        },
        required: ["id"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return ok(await handleDelete(getStore(), input as unknown as { id: string }));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];

  const resources = new Map([["files/browser", FILES_BROWSER_HTML]]);

  return new InlineSource("files", tools, {
    resources,
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
  });
}
