/**
 * The public tools' schemas: the TypeBox authoring source for the `$defs`
 * entries of every tool `contract.ts` marks public.
 *
 * `contracts/scripts/emit-contracts.ts` turns this file into the published
 * document (`schemas/contracts/files/v1/contract.json`), and `--check` fails
 * when the committed document differs. Nothing at runtime imports this file.
 *
 * The shapes are the files tools agents and the screen use: a file is named by
 * its `id` (the `<id>` of its `files://<id>` URI, CONTRACT.md §4), a folder by
 * its `folderId`, and `create` takes `{ manifest, body, encoding? }`. Every
 * difference from the tools these replace is listed in CONTRACT.md §15.
 *
 * Scope and principal are never arguments: they are carried by the call's host
 * context (CONTRACT.md §2). Inputs and outputs are open, as they were; a client
 * ignores an output field it does not know.
 */

import { type Static, type TInteger, type TSchema, Type } from "@sinclair/typebox";

/**
 * A string enum in the `{ type, enum }` form JSON Schema validators and MCP
 * clients expect, narrowed to its literals for TypeScript. For inputs only.
 */
export function StringEnum<T extends string>(
  values: readonly T[],
  options: { description?: string } = {},
) {
  return Type.Unsafe<T>({ type: "string", enum: [...values], ...options });
}

/**
 * A string in a public output whose known values are listed, never enumerated:
 * a later minor may add a value, and a client treats one it does not know as
 * unknown (CONTRACT.md §5).
 */
function OpenString(values: readonly string[], options: { description?: string } = {}) {
  const known = `Known values: ${values.join(", ")}. Any other is unknown (CONTRACT.md §5).`;
  return Type.String({
    description: options.description ? `${options.description} ${known}` : known,
  });
}

const Nullable = <T extends TSchema>(t: T, options: { description?: string } = {}) =>
  Type.Union([t, Type.Null()], options);

// ── Shared fields ────────────────────────────────────────────────────────

/** The coarse kinds `list` filters and counts by, from a file's MIME type. */
export const FILE_KINDS = ["image", "document", "data", "font", "other"] as const;

/** Where a file came from. `agent` is `create`'s; the others are the host's doors (`begin_upload`). */
export const FILE_SOURCES = ["chat", "agent", "app", "manual"] as const;

/** The grammar of a file id and a folder id: the implementation mints both (CONTRACT.md §4). */
export const ID_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";

/** The largest body `create` stores, decoded, in bytes (4 MiB; CONTRACT.md §7). */
export const MAX_CREATE_BYTES = 4 * 1024 * 1024;

/**
 * The types a file may have, in 1.0: every door's intake and `create` accept
 * these and refuse any other (`type_not_allowed`). A type is compared with its
 * parameters (`;charset=…`) stripped and case-folded (CONTRACT.md §7).
 */
export const ALLOWED_MIME_TYPES = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/zip",
  "application/gzip",
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "application/octet-stream",
] as const;

/** The most pages one `read` extracts (CONTRACT.md §8). */
export const MAX_READ_PAGES = 10;

/** The most UTF-8 bytes of text one `read` answers, in `extractedText` or across `pages` (1 MiB). */
export const MAX_READ_TEXT_BYTES = 1024 * 1024;

const FileIdField = (description = "File ID.") => Type.String({ description });

const FolderIdField = (description: string) =>
  Type.String({ pattern: "^(root|[a-z0-9][a-z0-9_-]{0,63})$", description });

const FolderIdOnly = Type.String({ pattern: ID_PATTERN, description: "Folder ID." });

const FolderNameField = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^[^/\\\\]+$",
  description: "Folder name. No '/' or '\\'; unique among the folders beside it.",
});

// ── Records ──────────────────────────────────────────────────────────────

/** A file's record, as `list`, `search`, `info` and the private `complete_upload` and `resolve` answer it. */
export const FileRecord = Type.Object({
  id: Type.String({ description: "The file's id: its URI is files://<id>." }),
  filename: Type.String(),
  mimeType: Type.String(),
  size: Type.Integer({ minimum: 0, description: "The body's size in bytes." }),
  tags: Type.Array(Type.String()),
  source: OpenString(FILE_SOURCES, { description: "Where the file came from." }),
  conversationId: Nullable(Type.String(), {
    description: "The conversation the file was attached in or written by, or null.",
  }),
  runId: Type.Optional(
    Nullable(Type.String(), { description: "The unattended run that wrote the file, or null." }),
  ),
  createdAt: Type.String({ description: "When the record was made (RFC 3339)." }),
  description: Nullable(Type.String()),
  folderId: Type.Optional(
    Nullable(Type.String(), { description: "The file's folder, or null at the top level." }),
  ),
  ownerId: Type.Optional(Type.String({ description: "Advisory: the owner the file belongs to." })),
  workspaceId: Type.Optional(
    Type.String({ description: "Advisory: the workspace the file belongs to." }),
  ),
});
export type FileRecord = Static<typeof FileRecord>;

/** A folder's record. */
export const FolderRecord = Type.Object({
  id: Type.String(),
  name: Type.String(),
  parentId: Nullable(Type.String()),
  createdAt: Type.String(),
});

/** A listed file, with the '/'-separated path of its folder ("" at the top level). */
const ListedFile = Type.Composite([FileRecord, Type.Object({ folderPath: Type.String() })]);

/** A listed folder, with its own '/'-separated path. */
const ListedFolder = Type.Composite([FolderRecord, Type.Object({ path: Type.String() })]);

/** A count for each of `keys`, every one present. */
function CountsBy<const T extends readonly string[]>(keys: T) {
  return Type.Object(
    Object.fromEntries(keys.map((k) => [k, Type.Integer()])) as Record<T[number], TInteger>,
  );
}

// ── Tools ────────────────────────────────────────────────────────────────

const ListInput = Type.Object({
  folderId: Type.Optional(
    FolderIdField(
      'Folder to list, by id; "root" for the top level. Omit to list files across every folder. ' +
        "When set, the result also holds the folders inside it.",
    ),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description: "With `folderId`, include files in its subfolders too. Default: false.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Case-insensitive text to match in the filename, description, or tags (and folder names).",
    }),
  ),
  kinds: Type.Optional(
    Type.Array(StringEnum(FILE_KINDS), {
      description:
        "Keep only files of these kinds, judged from the MIME type (CONTRACT.md §5, Types).",
    }),
  ),
  sources: Type.Optional(
    Type.Array(StringEnum(FILE_SOURCES), {
      description:
        'Keep only files from these sources: "chat" (attached in a chat), "agent" (written by an agent), "app" or "manual" (uploaded).',
    }),
  ),
  conversationId: Type.Optional(
    Type.String({ description: "Keep only files attached in or written by this conversation." }),
  ),
  runId: Type.Optional(Type.String({ description: "Keep only files written by this task run." })),
  createdAfter: Type.Optional(
    Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}",
      description: "Keep only files created at or after this ISO 8601 date or time.",
    }),
  ),
  createdBefore: Type.Optional(
    Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}",
      description: "Keep only files created before this ISO 8601 date or time.",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by tags (files must have ALL specified tags).",
    }),
  ),
  mimeType: Type.Optional(
    Type.String({
      description: "Filter by MIME type prefix (e.g. 'image/' matches image/png, image/jpeg).",
    }),
  ),
  sort: Type.Optional(
    StringEnum(["createdAt", "filename", "size"] as const, {
      description: 'Sort field. Default: "createdAt".',
    }),
  ),
  order: Type.Optional(
    StringEnum(["asc", "desc"] as const, {
      description:
        'Sort direction. Default: "desc" for createdAt and size (newest, largest first), "asc" for filename.',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 200, description: "Max files to return. Default: 20." }),
  ),
  cursor: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Opaque cursor from a previous response's `nextCursor`, passed back with the same filters and sort, unchanged. Omit for the first page.",
    }),
  ),
});

const ListOutput = Type.Object({
  files: Type.Array(ListedFile),
  total: Type.Integer({ description: "Every match, across pages." }),
  folders: Type.Array(ListedFolder),
  breadcrumb: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
  facets: Type.Object({
    kinds: CountsBy(FILE_KINDS),
    sources: CountsBy(FILE_SOURCES),
  }),
  nextCursor: Nullable(Type.String(), {
    description: "Pass as `cursor` for the next page; null on the last.",
  }),
});

const SearchInput = Type.Object(
  {
    query: Type.String({ description: "Search query." }),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags." })),
    mimeType: Type.Optional(Type.String({ description: "Filter by MIME type prefix." })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, description: "Max results. Default: 20." }),
    ),
  },
  { required: ["query"] },
);

const SearchOutput = Type.Object({ files: Type.Array(FileRecord), total: Type.Integer() });

const IdInput = (description = "File ID.") =>
  Type.Object({ id: FileIdField(description) }, { required: ["id"] });

const ReadInput = Type.Object(
  {
    id: FileIdField(),
    pages: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1, description: "1-based page number." }), {
        minItems: 1,
        maxItems: MAX_READ_PAGES,
        description:
          `Read only these 1-based pages of a paged document (a PDF), at most ${MAX_READ_PAGES} per call. ` +
          "Use it for a long PDF, or for pages past the truncated text. Omit to read the whole text.",
      }),
    ),
    maxBytes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_READ_TEXT_BYTES,
        description: `The most UTF-8 bytes of text to answer, across \`extractedText\` or \`pages\`. Default and most: ${MAX_READ_TEXT_BYTES}.`,
      }),
    ),
  },
  { required: ["id"] },
);

const ReadOutput = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  mimeType: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  extractedText: Nullable(Type.String(), {
    description:
      "The file's text, when its type is extractable and extraction succeeded; null otherwise, and with `pages`.",
  }),
  truncated: Type.Boolean({
    description:
      "Whether `extractedText` stops at the text bound or at `maxBytes`. False when `extractedText` is null, and with `pages`, where each page says its own.",
  }),
  totalPages: Type.Optional(Type.Integer({ description: "With `pages`: the document's pages." })),
  requestedPages: Type.Optional(
    Type.Array(Type.Integer(), {
      description: "With `pages`: the pages asked for, sorted, once each.",
    }),
  ),
  missingPages: Type.Optional(
    Type.Array(Type.Integer(), { description: "With `pages`: those past the document's end." }),
  ),
  pages: Type.Optional(
    Type.Array(
      Type.Object({
        page: Type.Integer(),
        text: Type.String(),
        truncated: Type.Boolean(),
        empty: Type.Boolean(),
      }),
      { description: "With `pages`: each requested page that exists, in order." },
    ),
  ),
});

const CreateInput = Type.Object(
  {
    manifest: Type.Object(
      {
        filename: Type.String({ description: "Filename (e.g. 'logo.png')." }),
        folder: Type.Optional(
          Type.String({
            description:
              "Folder path to put the file in, '/'-separated (e.g. 'Reports/Q3'). Folders that do not exist are created. Omit, or \"\", for the top level. A leading or trailing '/' or an empty segment is invalid_input.",
          }),
        ),
        mimeType: Type.String({
          description: `MIME type (e.g. 'image/png'), one of: ${ALLOWED_MIME_TYPES.join(", ")}. A generic or empty type for a known text extension is read as that extension's text type (CONTRACT.md §5, Types).`,
        }),
        tags: Type.Optional(
          Type.Array(Type.String(), { description: "Optional tags for categorization." }),
        ),
        description: Type.Optional(
          Type.String({ description: "Optional description of the file." }),
        ),
      },
      { required: ["filename", "mimeType"] },
    ),
    body: Type.String({
      description: `File content, at most ${MAX_CREATE_BYTES} bytes once decoded. Base64-encoded by default; pass encoding: "text" to write \`body\` verbatim.`,
    }),
    encoding: Type.Optional(
      StringEnum(["base64", "text"] as const, {
        description:
          'How to read `body`. "base64" (the default) decodes it as standard-alphabet base64 (A-Z a-z 0-9 + /) padded with `=` to a multiple of 4; line breaks are allowed, other whitespace is not, and unpadded or base64url (-, _) bodies are rejected. "text" writes `body` verbatim as UTF-8 — use it for markdown, code, CSV, or any content you are composing yourself.',
      }),
    ),
  },
  { required: ["manifest", "body"] },
);

const CreateOutput = Type.Object({
  id: Type.String({ description: "The new file's id: its URI is files://<id>." }),
  filename: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  folderId: Nullable(Type.String(), {
    description: "The stored file's folder, or `null` at the top level.",
  }),
});

const TagInput = Type.Object(
  {
    id: FileIdField(),
    add: Type.Optional(Type.Array(Type.String(), { description: "Tags to add." })),
    remove: Type.Optional(Type.Array(Type.String(), { description: "Tags to remove." })),
  },
  { required: ["id"] },
);

const MoveInput = Type.Object(
  {
    ids: Type.Array(FileIdField(), {
      minItems: 1,
      maxItems: 200,
      description: "The files to move.",
    }),
    folderId: FolderIdField('A folder id, or "root" for the top level.'),
  },
  { required: ["ids", "folderId"] },
);

const CreateFolderInput = Type.Object(
  {
    manifest: Type.Object(
      {
        name: FolderNameField,
        parentId: Type.Optional(FolderIdField('A folder id, or "root" for the top level.')),
      },
      { required: ["name"] },
    ),
  },
  { required: ["manifest"] },
);

const UpdateFolderInput = Type.Object(
  {
    id: FolderIdOnly,
    manifest: Type.Object(
      {
        name: Type.Optional(FolderNameField),
        parentId: Type.Optional(FolderIdField('A folder id, or "root" for the top level.')),
      },
      { description: "The fields to change: `name` renames, `parentId` moves." },
    ),
  },
  { required: ["id", "manifest"] },
);

const Deleted = Type.Object({ deleted: Type.Literal(true) });

/** Every public tool: name → input and output schema. */
export const PUBLIC_SCHEMAS = {
  list: { input: ListInput, output: ListOutput },
  search: { input: SearchInput, output: SearchOutput },
  info: { input: IdInput(), output: FileRecord },
  read: { input: ReadInput, output: ReadOutput },
  create: { input: CreateInput, output: CreateOutput },
  tag: {
    input: TagInput,
    output: Type.Object({ id: Type.String(), tags: Type.Array(Type.String()) }),
  },
  move: {
    input: MoveInput,
    output: Type.Object({ ids: Type.Array(Type.String()), folderId: Nullable(Type.String()) }),
  },
  delete: { input: IdInput(), output: Deleted },
  create_folder: { input: CreateFolderInput, output: ListedFolder },
  update_folder: { input: UpdateFolderInput, output: ListedFolder },
  delete_folder: {
    input: Type.Object({ id: FolderIdOnly }, { required: ["id"] }),
    output: Deleted,
  },
};
