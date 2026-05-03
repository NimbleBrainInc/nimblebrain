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
