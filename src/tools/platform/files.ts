/**
 * Files InlineSource — workspace file store backed by a JSONL registry and
 * on-disk binary storage.
 *
 * Tools (7): list, search, read, create, info, tag, delete
 * Resources: files/browser (React SPA)
 * Placements: sidebar files link at priority 3
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { textContent } from "../../engine/content-helpers.ts";
import type { ToolResult } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { InlineSource, type InlineToolDef } from "../inline-source.ts";
import { FILES_BROWSER_HTML } from "../platform-resources/files/browser.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  tags: string[];
  source: string;
  conversationId: string | null;
  createdAt: string;
  description: string | null;
  deleted?: boolean;
  deletedAt?: string;
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `fl_${randomBytes(12).toString("hex")}`;
}

function ensureDir(filesDir: string): void {
  if (!existsSync(filesDir)) {
    mkdirSync(filesDir, { recursive: true });
  }
}

function readRegistry(registryPath: string): FileEntry[] {
  if (!existsSync(registryPath)) {
    return [];
  }
  const content = readFileSync(registryPath, "utf-8").trim();
  if (!content) return [];

  const lines = content.split("\n");
  const entries: FileEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip invalid registry lines
    }
  }
  return entries;
}

/**
 * Resolve the registry to the latest state per ID (last-write-wins).
 * Filters out tombstoned entries.
 */
function resolveRegistry(registryPath: string): FileEntry[] {
  const raw = readRegistry(registryPath);
  const map = new Map<string, FileEntry>();
  for (const entry of raw) {
    map.set(entry.id, entry);
  }
  return Array.from(map.values()).filter((e) => !e.deleted);
}

function appendEntry(registryPath: string, filesDir: string, entry: FileEntry): void {
  ensureDir(filesDir);
  appendFileSync(registryPath, `${JSON.stringify(entry)}\n`);
}

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

function handleList(registryPath: string, args: ListInput): object {
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const sort = args.sort ?? "createdAt";

  let files = resolveRegistry(registryPath);

  if (args.tags && args.tags.length > 0) {
    const requiredTags = args.tags;
    files = files.filter((f) => requiredTags.every((t) => f.tags.includes(t)));
  }

  if (args.mimeType) {
    const prefix = args.mimeType;
    files = files.filter((f) => f.mimeType.startsWith(prefix));
  }

  if (sort === "createdAt") {
    files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } else if (sort === "filename") {
    files.sort((a, b) => a.filename.localeCompare(b.filename));
  } else if (sort === "size") {
    files.sort((a, b) => b.size - a.size);
  }

  const total = files.length;
  const paginated = files.slice(offset, offset + limit);

  return { files: paginated, total };
}

interface SearchInput {
  query: string;
  tags?: string[];
  mimeType?: string;
  limit?: number;
}

function handleSearch(registryPath: string, args: SearchInput): object {
  const limit = args.limit ?? 20;
  const query = args.query.toLowerCase();

  let files = resolveRegistry(registryPath);

  if (args.tags && args.tags.length > 0) {
    const requiredTags = args.tags;
    files = files.filter((f) => requiredTags.every((t) => f.tags.includes(t)));
  }

  if (args.mimeType) {
    const prefix = args.mimeType;
    files = files.filter((f) => f.mimeType.startsWith(prefix));
  }

  files = files.filter((f) => {
    const searchable = [f.filename, f.description ?? "", ...f.tags].join(" ").toLowerCase();
    return searchable.includes(query);
  });

  files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { files: files.slice(0, limit), total: files.length };
}

function handleRead(registryPath: string, filesDir: string, args: { id: string }): object {
  const files = resolveRegistry(registryPath);
  const entry = files.find((f) => f.id === args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }

  const filePath = join(filesDir, `${entry.id}_${entry.filename}`);
  if (!existsSync(filePath)) {
    throw new Error(`File data missing from disk: ${entry.id}`);
  }

  const data = readFileSync(filePath);
  const base64Data = Buffer.from(data).toString("base64");

  return {
    base64Data,
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

function handleCreate(registryPath: string, filesDir: string, args: CreateInput): object {
  ensureDir(filesDir);

  const id = generateId();
  const decoded = Buffer.from(args.base64_data, "base64");
  const filePath = join(filesDir, `${id}_${args.filename}`);

  writeFileSync(filePath, decoded);

  const entry: FileEntry = {
    id,
    filename: args.filename,
    mimeType: args.mime_type,
    size: decoded.length,
    tags: args.tags ?? [],
    source: "api",
    conversationId: null,
    createdAt: new Date().toISOString(),
    description: args.description ?? null,
  };

  appendEntry(registryPath, filesDir, entry);

  return { id, filename: args.filename, size: decoded.length };
}

function handleInfo(registryPath: string, args: { id: string }): object {
  const files = resolveRegistry(registryPath);
  const entry = files.find((f) => f.id === args.id);
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

function handleTag(registryPath: string, filesDir: string, args: TagInput): object {
  const files = resolveRegistry(registryPath);
  const entry = files.find((f) => f.id === args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }

  const tagSet = new Set(entry.tags);

  if (args.add) {
    for (const t of args.add) tagSet.add(t);
  }
  if (args.remove) {
    for (const t of args.remove) tagSet.delete(t);
  }

  const newTags = Array.from(tagSet);
  const updated: FileEntry = { ...entry, tags: newTags };
  appendEntry(registryPath, filesDir, updated);

  return { id: args.id, tags: newTags };
}

function handleDelete(registryPath: string, filesDir: string, args: { id: string }): object {
  const files = resolveRegistry(registryPath);
  const entry = files.find((f) => f.id === args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }

  const tombstone: FileEntry = {
    ...entry,
    deleted: true,
    deletedAt: new Date().toISOString(),
  };
  appendEntry(registryPath, filesDir, tombstone);

  const filePath = join(filesDir, `${entry.id}_${entry.filename}`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the "files" InlineSource. */
export function createFilesSource(runtime: Runtime): InlineSource {
  /** Resolve workspace-scoped files directory and registry path per-request. */
  function getFilePaths(): { filesDir: string; registryPath: string } {
    const wsDir = runtime.getWorkspaceScopedDir();
    const filesDir = join(wsDir, "files");
    const registryPath = join(filesDir, "registry.jsonl");
    return { filesDir, registryPath };
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
          const { registryPath } = getFilePaths();
          return ok(handleList(registryPath, input as unknown as ListInput));
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
          const { registryPath } = getFilePaths();
          return ok(handleSearch(registryPath, input as unknown as SearchInput));
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
          const { filesDir, registryPath } = getFilePaths();
          return ok(handleRead(registryPath, filesDir, input as unknown as { id: string }));
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
          const { filesDir, registryPath } = getFilePaths();
          return ok(handleCreate(registryPath, filesDir, input as unknown as CreateInput));
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
          const { registryPath } = getFilePaths();
          return ok(handleInfo(registryPath, input as unknown as { id: string }));
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
          const { filesDir, registryPath } = getFilePaths();
          return ok(handleTag(registryPath, filesDir, input as unknown as TagInput));
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
          const { filesDir, registryPath } = getFilePaths();
          return ok(handleDelete(registryPath, filesDir, input as unknown as { id: string }));
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
