import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

/** The coarse kinds `files__list` filters and counts by, from a file's MIME type. */
export const FILE_KINDS = ["image", "document", "data", "font", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Where a file came from, as `FileRecord.source` stores it. */
export const FILE_SOURCES = ["chat", "agent", "app", "manual"] as const;
export type FileSource = (typeof FILE_SOURCES)[number];

/** The id `folderId` takes for the top level, which is not a folder record. */
export const ROOT_FOLDER_ID = "root";

const FolderIdField = Type.String({
  pattern: "^(root|fd_[a-f0-9]{24})$",
  description: 'A folder id (`fd_…`), or "root" for the top level.',
});

export const FilesListInput = Type.Object({
  folderId: Type.Optional(
    Type.String({
      pattern: "^(root|fd_[a-f0-9]{24})$",
      description:
        'Folder to list, by id; "root" for the top level. Omit to list files across every folder. ' +
        "When set, the result also holds the folders inside it.",
    }),
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
      description: "Keep only files of these kinds, judged from the MIME type.",
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
  runId: Type.Optional(
    Type.String({ description: "Keep only files written by this automation run." }),
  ),
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
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Number of files to skip. Default: 0." }),
  ),
});
export type FilesListInput = Static<typeof FilesListInput>;

export const FilesSearchInput = Type.Object(
  {
    query: Type.String({ description: "Search query." }),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Filter by tags." })),
    mimeType: Type.Optional(Type.String({ description: "Filter by MIME type prefix." })),
    limit: Type.Optional(Type.Number({ description: "Max results. Default: 20." })),
  },
  { required: ["query"] },
);
export type FilesSearchInput = Static<typeof FilesSearchInput>;

export const FilesReadInput = Type.Object(
  { id: Type.String({ description: "File ID." }) },
  { required: ["id"] },
);
export type FilesReadInput = Static<typeof FilesReadInput>;

export const FilesReadPdfPagesInput = Type.Object(
  {
    id: Type.String({ description: "PDF file ID." }),
    pages: Type.Array(Type.Integer({ minimum: 1, description: "1-based PDF page number." }), {
      minItems: 1,
      maxItems: 10,
      description: "Specific 1-based PDF pages to extract text from. Max 10 pages per call.",
    }),
  },
  { required: ["id", "pages"] },
);
export type FilesReadPdfPagesInput = Static<typeof FilesReadPdfPagesInput>;

export interface FilesReadPdfPagesOutput {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  totalPages: number;
  requestedPages: number[];
  missingPages: number[];
  pages: Array<{
    page: number;
    text: string;
    truncated: boolean;
    empty: boolean;
  }>;
}

export const FilesCreateInput = Type.Object(
  {
    manifest: Type.Object(
      {
        filename: Type.String({ description: "Filename (e.g. 'logo.png')." }),
        folder: Type.Optional(
          Type.String({
            description:
              "Folder path to put the file in, '/'-separated (e.g. 'Reports/Q3'). Folders that do not exist are created. Omit for the top level.",
          }),
        ),
        mimeType: Type.String({ description: "MIME type (e.g. 'image/png')." }),
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
      description:
        'File content. Base64-encoded by default; pass encoding: "text" to write `body` verbatim.',
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
export type FilesCreateInput = Static<typeof FilesCreateInput>;

export const FilesInfoInput = Type.Object(
  { id: Type.String({ description: "File ID." }) },
  { required: ["id"] },
);
export type FilesInfoInput = Static<typeof FilesInfoInput>;

export const FilesTagInput = Type.Object(
  {
    id: Type.String({ description: "File ID." }),
    add: Type.Optional(Type.Array(Type.String(), { description: "Tags to add." })),
    remove: Type.Optional(Type.Array(Type.String(), { description: "Tags to remove." })),
  },
  { required: ["id"] },
);
export type FilesTagInput = Static<typeof FilesTagInput>;

export const FilesDeleteInput = Type.Object(
  { id: Type.String({ description: "File ID." }) },
  { required: ["id"] },
);
export type FilesDeleteInput = Static<typeof FilesDeleteInput>;

export const FilesMoveInput = Type.Object(
  {
    ids: Type.Array(Type.String({ description: "File ID." }), {
      minItems: 1,
      maxItems: 200,
      description: "The files to move.",
    }),
    folderId: FolderIdField,
  },
  { required: ["ids", "folderId"] },
);
export type FilesMoveInput = Static<typeof FilesMoveInput>;

const FolderNameField = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^[^/\\\\]+$",
  description: "Folder name. No '/' or '\\'; unique among the folders beside it.",
});

export const FilesCreateFolderInput = Type.Object(
  {
    manifest: Type.Object(
      {
        name: FolderNameField,
        parentId: Type.Optional(FolderIdField),
      },
      { required: ["name"] },
    ),
  },
  { required: ["manifest"] },
);
export type FilesCreateFolderInput = Static<typeof FilesCreateFolderInput>;

export const FilesUpdateFolderInput = Type.Object(
  {
    id: Type.String({ pattern: "^fd_[a-f0-9]{24}$", description: "Folder ID." }),
    manifest: Type.Object(
      {
        name: Type.Optional(FolderNameField),
        parentId: Type.Optional(FolderIdField),
      },
      { description: "The fields to change: `name` renames, `parentId` moves." },
    ),
  },
  { required: ["id", "manifest"] },
);
export type FilesUpdateFolderInput = Static<typeof FilesUpdateFolderInput>;

export const FilesDeleteFolderInput = Type.Object(
  { id: Type.String({ pattern: "^fd_[a-f0-9]{24}$", description: "Folder ID." }) },
  { required: ["id"] },
);
export type FilesDeleteFolderInput = Static<typeof FilesDeleteFolderInput>;

// ── Output types ────────────────────────────────────────────────────────

/**
 * A file's registry entry, as `files__list`, `files__search`, and
 * `files__info` return it. Mirror of `FileEntry` (`src/files/types.ts`),
 * held to it by `src/platform/files/output-types-drift-guard.ts`.
 */
export interface FileRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  tags: string[];
  source: FileSource;
  conversationId: string | null;
  runId?: string | null;
  createdAt: string;
  description: string | null;
  folderId?: string | null;
  ownerId?: string;
  workspaceId?: string;
  visibility?: "private" | "shared";
  deleted?: true;
  deletedAt?: string;
}

/**
 * A folder record. Mirror of `FolderEntry` (`src/files/types.ts`), held to it
 * by `src/platform/files/output-types-drift-guard.ts`.
 */
export interface FolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  deleted?: true;
  deletedAt?: string;
}

/** A listed file, with the '/'-separated path of its folder ("" at the top level). */
export type ListedFile = FileRecord & { folderPath: string };

/** A listed folder, with its own '/'-separated path. */
export type ListedFolder = FolderRecord & { path: string };

/**
 * What `files__list` returns.
 *
 * - `files`: one page of matching files; `total` counts every match.
 * - `folders`: with `folderId`, the folders inside it (matching `query`, if
 *   any); without it, folders anywhere whose name matches `query`. Empty when a
 *   kind, source, provenance, date, tag, or MIME filter is set, since those
 *   describe files.
 * - `breadcrumb`: the listed folder and its ancestors, top first; empty at the
 *   top level or without `folderId`.
 * - `facets`: how many matches each kind and source has, each counted with
 *   every filter but its own, so a count says what choosing it would show.
 */
export interface FilesListOutput {
  files: ListedFile[];
  total: number;
  folders: ListedFolder[];
  breadcrumb: Array<{ id: string; name: string }>;
  facets: {
    kinds: Record<FileKind, number>;
    sources: Record<FileSource, number>;
  };
}

/** What `files__move` returns: the moved files' ids and their folder. */
export interface FilesMoveOutput {
  ids: string[];
  folderId: string | null;
}

/** What `files__create_folder` and `files__update_folder` return. */
export type FilesFolderOutput = ListedFolder;

/** What `files__delete_folder` returns. */
export interface FilesDeleteFolderOutput {
  deleted: true;
}

/** What `files__search` returns: the newest matches up to `limit`, and the count of all matches. */
export interface FilesSearchOutput {
  files: FileRecord[];
  total: number;
}

/** What `files__create` returns: the stored file's id, its filename, and its size in bytes. */
export interface FilesCreateOutput {
  id: string;
  filename: string;
  size: number;
  /** The stored file's folder, or `null` at the top level. */
  folderId: string | null;
}

/** What `files__info` returns: the file's registry entry. */
export type FilesInfoOutput = FileRecord;

/** What `files__tag` returns: the file's tags after the change. */
export interface FilesTagOutput {
  id: string;
  tags: string[];
}

/** What `files__delete` returns. */
export interface FilesDeleteOutput {
  deleted: true;
}
