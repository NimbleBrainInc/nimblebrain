import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

export const FilesListInput = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max files to return. Default: 20." })),
  offset: Type.Optional(Type.Number({ description: "Number of files to skip. Default: 0." })),
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
  workspaceId: Type.Optional(
    Type.String({
      description:
        "Filter: only files that ran in this room (workspace). Applied before the limit, so the page reflects the room's set. Omit for all rooms.",
    }),
  ),
  includeUnstamped: Type.Optional(
    Type.Boolean({
      description:
        "When workspaceId is set, also include files with no stamped room — legacy files belong to the personal room. Default false.",
    }),
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
    body: Type.String({ description: "File content as a base64-encoded string." }),
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
