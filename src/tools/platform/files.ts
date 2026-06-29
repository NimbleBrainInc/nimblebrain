/**
 * Files platform source — in-process MCP server backing the caller's
 * identity-owned file store (`users/{userId}/files/`; Phase B). `files` is a
 * kernel identity source, so its tools dispatch bare through the identity
 * door. Files are persisted via a JSONL registry and on-disk binary storage.
 *
 * Both this tool source and the chat multipart ingest path
 * (`src/api/handlers.ts::handleChat` / `handleChatStream`) share a single
 * `FileStore` implementation from `src/files/store.ts`. Storage identity —
 * directory layout, ID scheme, registry semantics — lives there. This
 * module only defines the tool schemas and adapts calls into the store.
 *
 * Tools (8): list, search, read, read_pdf_pages, create, info, tag, delete
 * Resources: ui://files/browser (React SPA)
 * Placements: sidebar files link at priority 3
 */

import { textContent } from "../../engine/content-helpers.ts";
import type { ContentBlock, EventSink, ToolResult } from "../../engine/types.ts";
import { extractPdfPages, extractText } from "../../files/extract.ts";
import { IMAGE_TYPES, isExtractable, PDF_TYPES } from "../../files/ingest.ts";
import { isTextMime, resolveMimeType } from "../../files/mime.ts";
import type { FileStore } from "../../files/store.ts";
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
  FilesReadPdfPagesInput,
  type FilesReadPdfPagesOutput,
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
  /** Scope to one room. Applied before pagination so the page reflects the room's set. */
  workspaceId?: string;
  /** With `workspaceId`, include roomless (legacy) files — they belong to the personal room. */
  includeUnstamped?: boolean;
}

// Scope a file set to one room. A file with no stamped room (legacy) belongs to
// the personal room, so it's kept only when the caller asks via `includeUnstamped`
// (set when the focused room is personal). Mirrors the conversation-list filter.
function filterByRoom(
  entries: FileEntry[],
  workspaceId: string | undefined,
  includeUnstamped: boolean,
): FileEntry[] {
  if (!workspaceId) return entries;
  return entries.filter((f) => (f.workspaceId ? f.workspaceId === workspaceId : includeUnstamped));
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
  // Room filter runs before sort/slice, so the limit applies to the room's
  // set rather than slicing a global page we'd then drop out-of-room files from.
  const scoped = filterByRoom(all, args.workspaceId, args.includeUnstamped ?? false);
  const files = filterEntries(scoped, args.tags, args.mimeType);

  if (sort === "createdAt") {
    files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } else if (sort === "filename") {
    files.sort((a, b) => a.filename.localeCompare(b.filename));
  } else if (sort === "size") {
    files.sort((a, b) => b.size - a.size);
  }

  return { files: files.slice(offset, offset + limit), totalCount: files.length };
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

  return { files: files.slice(0, limit), totalCount: files.length };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Read a file. Returns a `resource_link` reference plus a human-readable
 * text block; never returns the bytes inline. For text-extractable types
 * (text/code, PDF, DOCX, XLSX) the text block includes the extracted text
 * up to `maxExtractedTextSize`.
 *
 * Bytes were previously surfaced as a base64 string in the tool result.
 * The model could not consume base64 as image/PDF input — providers handle
 * those via native file parts on user uploads (see `src/files/rehydrate.ts`)
 * — so the base64 path produced unusable payloads while inflating the
 * conversation log and replay tokens by 5–10× per byte. This handler is the
 * single seam where that leak is closed for the agent-pull direction; the
 * user-attachment direction is already lean via `ingest.ts`.
 */
async function handleRead(
  store: FileStore,
  maxExtractedTextSize: number,
  args: { id: string },
): Promise<ToolResult> {
  // `findEntry` so a missing id is a clean "not found" without touching
  // bytes. Mirrors the prior behavior of the pre-change `readFile` throw.
  const entry = await store.findEntry(args.id);
  if (!entry) {
    return {
      content: textContent(JSON.stringify({ error: `File not found: ${args.id}` })),
      isError: true,
    };
  }

  const sizeText = humanSize(entry.size);
  const intro = `Read ${entry.filename} (${sizeText}, ${entry.mimeType}).`;

  // The resource_link is the durable, byte-free reference. Every result
  // includes one so any resource_link-aware consumer can locate the
  // identity-owned `files://` resource without re-reading through this tool.
  // Today `extractTextForModel` filters these out of the LLM-bound text,
  // which is what we want: the model receives the human text block; the
  // link rides alongside for tool-result metadata, UI rendering, and a
  // future tool-side rehydration pass.
  const link: ContentBlock = {
    type: "resource_link",
    uri: fileIdToUri(args.id),
    name: entry.filename,
    mimeType: entry.mimeType,
    size: entry.size,
    description: sizeText,
  } as ContentBlock;

  const structured: Record<string, unknown> = {
    id: entry.id,
    filename: entry.filename,
    mimeType: entry.mimeType,
    size: entry.size,
    extractedText: null,
    truncated: false,
  };

  // PDFs route through the same `extractText` path as docs/text because the
  // agent-pull surface only ever delivers text from this tool. (Native PDF
  // input for capable models is a different seam — `rehydrate.ts` at the
  // user-attachment boundary.)
  const canExtract = isExtractable(entry.mimeType) || PDF_TYPES.has(entry.mimeType);
  if (canExtract) {
    const read = await store.readFile(args.id);
    const extracted = await extractText(read.data, read.mimeType, maxExtractedTextSize);
    if (extracted) {
      structured.extractedText = extracted.text;
      structured.truncated = extracted.truncated;
      return {
        content: [
          link,
          { type: "text", text: `${intro}\n\n--- Extracted text ---\n${extracted.text}` },
        ],
        structuredContent: structured,
        isError: false,
      };
    }
    // Extraction supported in principle but failed at runtime (corrupt /
    // empty / decoder error). Fall through to a metadata-only response;
    // the resource_link is still useful, the bytes aren't.
    return {
      content: [
        link,
        {
          type: "text",
          text: `${intro} Text extraction was not successful for this file; only metadata is available.`,
        },
      ],
      structuredContent: structured,
      isError: false,
    };
  }

  // Non-extractable: images, fonts, archives, raw binary. The model has no
  // useful surface for these via the tool — vision-capable models receive
  // images through the user-attachment rehydration path, not here.
  const note = IMAGE_TYPES.has(entry.mimeType)
    ? " Images attached to a user message are rehydrated as native vision input on the next turn; reading them here returns metadata only."
    : " This MIME type is not text-extractable; only metadata is available.";
  return {
    content: [link, { type: "text", text: `${intro}${note}` }],
    structuredContent: structured,
    isError: false,
  };
}

async function handleReadPdfPages(
  store: FileStore,
  args: FilesReadPdfPagesInput,
): Promise<ToolResult> {
  const entry = await store.findEntry(args.id);
  if (!entry) {
    return {
      content: textContent(JSON.stringify({ error: `File not found: ${args.id}` })),
      isError: true,
    };
  }

  if (!PDF_TYPES.has(entry.mimeType)) {
    return {
      content: textContent(
        JSON.stringify({ error: `File is not a PDF: ${entry.filename} (${entry.mimeType})` }),
      ),
      isError: true,
    };
  }

  const requestedPages = Array.from(new Set(args.pages)).sort((a, b) => a - b);
  const read = await store.readFile(args.id);
  const extracted = await extractPdfPages(read.data, requestedPages);
  if (!extracted) {
    return {
      content: textContent(
        JSON.stringify({ error: `PDF page text extraction failed: ${entry.id}` }),
      ),
      isError: true,
    };
  }

  const sizeText = humanSize(entry.size);
  const link: ContentBlock = {
    type: "resource_link",
    uri: fileIdToUri(args.id),
    name: entry.filename,
    mimeType: entry.mimeType,
    size: entry.size,
    description: sizeText,
  } as ContentBlock;

  const out: FilesReadPdfPagesOutput = {
    id: entry.id,
    filename: entry.filename,
    mimeType: entry.mimeType,
    size: entry.size,
    totalPages: extracted.totalPages,
    requestedPages,
    missingPages: extracted.missingPages,
    pages: extracted.pages,
  };

  const pageText = extracted.pages
    .map(
      (page) => `--- Page ${page.page} ---\n${page.text || "[No extractable text on this page]"}`,
    )
    .join("\n\n");
  const missingText =
    extracted.missingPages.length > 0
      ? `\n\nMissing pages: ${extracted.missingPages.join(", ")} (PDF has ${extracted.totalPages} ${extracted.totalPages === 1 ? "page" : "pages"}).`
      : "";
  const text =
    `Read PDF pages ${requestedPages.join(", ")} from ${entry.filename} (${sizeText}, ${entry.mimeType}; ${extracted.totalPages} pages).` +
    (pageText ? `\n\n${pageText}` : "") +
    missingText;

  return {
    content: [link, { type: "text", text }],
    structuredContent: out as unknown as Record<string, unknown>,
    isError: false,
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
  // Recover a text type from the filename when the agent supplies a generic
  // `application/octet-stream` (or empty) for a known text/source extension;
  // a specific type is trusted as-is. Same recovery as the upload handlers,
  // so an agent-written `.typ` is readable just like an uploaded one.
  const mimeType = resolveMimeType(manifest.filename, manifest.mimeType);
  const saved = await store.saveFile(decoded, manifest.filename, mimeType);
  const entry: FileEntry = {
    id: saved.id,
    filename: manifest.filename,
    mimeType,
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
  /**
   * Resolve the caller's identity-scoped file store. Files are identity-owned
   * (Phase B): the store lives at `users/{userId}/files/`, not in any
   * workspace. `files` is a kernel identity source, so the dispatcher always
   * runs these tools with an authenticated identity in the request context;
   * absence is a misrouted call, not a recoverable state.
   */
  function getStore(): FileStore {
    // Resolve the owner through the one shared rule (`resolveRequestUserId`) —
    // the same path automations' source, the REST file handlers, and chat
    // rehydration use, so "who am I" never drifts between sources. Fail-closed
    // in production (throws when an identity provider is configured but the
    // request carries no identity); DEV_IDENTITY only in dev.
    return runtime.getFileStore(
      runtime.resolveRequestUserId(runtime.getCurrentIdentity() ?? undefined),
    );
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
      description: "List your files with pagination, filtering by tags or MIME type, and sorting.",
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
      description:
        "Read a file by ID. Returns a resource_link reference and a human-readable summary. " +
        "For text-extractable formats (text, code, JSON, Markdown, CSV, HTML, XML, YAML, PDF, " +
        "DOCX, XLSX) the summary includes the extracted text up to the platform's " +
        "max-extracted-text size. For images and other non-extractable binary, only metadata " +
        "is returned — images attached to a user message are delivered to the model via native " +
        "file input on the next turn, not through this tool.",
      inputSchema: FilesReadInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await handleRead(
            getStore(),
            runtime.getFilesConfig().maxExtractedTextSize,
            input as unknown as { id: string },
          );
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "read_pdf_pages",
      description:
        "Read extracted text from specific 1-based pages of a PDF by file ID. " +
        "Use this for oversized PDFs or when the user asks about pages beyond the truncated attachment preview. " +
        "Returns bounded per-page text only, never the whole PDF or base64 bytes. Max 10 pages per call.",
      inputSchema: FilesReadPdfPagesInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await handleReadPdfPages(getStore(), input as unknown as FilesReadPdfPagesInput);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "create",
      description:
        "Create a new file in your file store. `manifest` is the file metadata; `body` is the base64-encoded content.",
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
