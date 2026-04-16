/**
 * MCP server entry point for @nimblebraininc/files bundle.
 *
 * Manages a workspace file store backed by FILES_DIR with a JSONL registry.
 * Exposes 7 tools: list, search, read, write, info, tag, delete.
 * Uses stdio transport — stdout is JSON-RPC only, logging goes to stderr.
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
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { BROWSER_HTML } from "./ui/browser.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORK_DIR = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
const FILES_DIR = join(WORK_DIR, "files");
const REGISTRY_PATH = join(FILES_DIR, "registry.jsonl");

function log(msg: string): void {
  process.stderr.write(`[files] ${msg}\n`);
}

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

function ensureDir(): void {
  if (!existsSync(FILES_DIR)) {
    mkdirSync(FILES_DIR, { recursive: true });
  }
}

function readRegistry(): FileEntry[] {
  if (!existsSync(REGISTRY_PATH)) {
    return [];
  }
  const content = readFileSync(REGISTRY_PATH, "utf-8").trim();
  if (!content) return [];

  const lines = content.split("\n");
  const entries: FileEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      log(`Skipping invalid registry line: ${line.slice(0, 80)}`);
    }
  }
  return entries;
}

/**
 * Resolve the registry to the latest state per ID (last-write-wins).
 * Filters out tombstoned entries.
 */
function resolveRegistry(): FileEntry[] {
  const raw = readRegistry();
  const map = new Map<string, FileEntry>();
  for (const entry of raw) {
    map.set(entry.id, entry);
  }
  return Array.from(map.values()).filter((e) => !e.deleted);
}

function appendEntry(entry: FileEntry): void {
  ensureDir();
  appendFileSync(REGISTRY_PATH, `${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
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
          description: "Filter by MIME type prefix (e.g. 'image/' matches image/png, image/jpeg).",
        },
        sort: {
          type: "string",
          enum: ["createdAt", "filename", "size"],
          description: 'Sort field. Default: "createdAt".',
        },
      },
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
  },
  {
    name: "write",
    description: "Write a new file to the workspace. Provide base64-encoded data.",
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
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

interface ListInput {
  limit?: number;
  offset?: number;
  tags?: string[];
  mimeType?: string;
  sort?: "createdAt" | "filename" | "size";
}

function handleList(args: ListInput): object {
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const sort = args.sort ?? "createdAt";

  let files = resolveRegistry();

  // Filter by tags
  if (args.tags && args.tags.length > 0) {
    const requiredTags = args.tags;
    files = files.filter((f) => requiredTags.every((t) => f.tags.includes(t)));
  }

  // Filter by MIME type prefix
  if (args.mimeType) {
    const prefix = args.mimeType;
    files = files.filter((f) => f.mimeType.startsWith(prefix));
  }

  // Sort
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

function handleSearch(args: SearchInput): object {
  const limit = args.limit ?? 20;
  const query = args.query.toLowerCase();

  let files = resolveRegistry();

  // Filter by tags
  if (args.tags && args.tags.length > 0) {
    const requiredTags = args.tags;
    files = files.filter((f) => requiredTags.every((t) => f.tags.includes(t)));
  }

  // Filter by MIME type prefix
  if (args.mimeType) {
    const prefix = args.mimeType;
    files = files.filter((f) => f.mimeType.startsWith(prefix));
  }

  // Case-insensitive substring match on filename, description, tags
  files = files.filter((f) => {
    const searchable = [f.filename, f.description ?? "", ...f.tags].join(" ").toLowerCase();
    return searchable.includes(query);
  });

  // Sort by relevance (createdAt desc as a simple heuristic)
  files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { files: files.slice(0, limit), total: files.length };
}

interface ReadInput {
  id: string;
}

function handleRead(args: ReadInput): object {
  const files = resolveRegistry();
  const entry = files.find((f) => f.id === args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }

  const filePath = join(FILES_DIR, `${entry.id}_${entry.filename}`);
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

interface WriteInput {
  filename: string;
  base64_data: string;
  mime_type: string;
  tags?: string[];
  description?: string;
}

function handleWrite(args: WriteInput): object {
  ensureDir();

  const id = generateId();
  const decoded = Buffer.from(args.base64_data, "base64");
  const filePath = join(FILES_DIR, `${id}_${args.filename}`);

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

  appendEntry(entry);
  log(`Written file: ${id} (${args.filename}, ${decoded.length} bytes)`);

  return { id, filename: args.filename, size: decoded.length };
}

interface InfoInput {
  id: string;
}

function handleInfo(args: InfoInput): object {
  const files = resolveRegistry();
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

function handleTag(args: TagInput): object {
  const files = resolveRegistry();
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
  appendEntry(updated);

  log(`Updated tags for ${args.id}: [${newTags.join(", ")}]`);

  return { id: args.id, tags: newTags };
}

interface DeleteInput {
  id: string;
}

function handleDelete(args: DeleteInput): object {
  const files = resolveRegistry();
  const entry = files.find((f) => f.id === args.id);
  if (!entry) {
    throw new Error(`File not found: ${args.id}`);
  }

  // Append tombstone
  const tombstone: FileEntry = {
    ...entry,
    deleted: true,
    deletedAt: new Date().toISOString(),
  };
  appendEntry(tombstone);

  // Remove file from disk
  const filePath = join(FILES_DIR, `${entry.id}_${entry.filename}`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  log(`Deleted file: ${args.id} (${entry.filename})`);

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Tool routing
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

function routeToolCall(name: string, args: ToolArgs): object {
  switch (name) {
    case "list":
      return handleList(args as unknown as ListInput);
    case "search":
      return handleSearch(args as unknown as SearchInput);
    case "read":
      return handleRead(args as unknown as ReadInput);
    case "write":
      return handleWrite(args as unknown as WriteInput);
    case "info":
      return handleInfo(args as unknown as InfoInput);
    case "tag":
      return handleTag(args as unknown as TagInput);
    case "delete":
      return handleDelete(args as unknown as DeleteInput);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting with files dir: ${FILES_DIR}`);
  ensureDir();

  const existing = resolveRegistry();
  log(`Registry contains ${existing.length} files`);

  // Create MCP server
  const server = new Server(
    {
      name: "@nimblebraininc/files",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = routeToolCall(name, args ?? {});
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Tool error (${name}): ${message}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  // Register resource listing handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "ui://files/browser",
        name: "File Browser",
        mimeType: "text/html",
      },
    ],
  }));

  // Register resource read handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "ui://files/browser") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/html",
            text: BROWSER_HTML,
          },
        ],
      };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Server connected via stdio");

  // Clean shutdown
  const shutdown = async () => {
    log("Shutting down...");
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
