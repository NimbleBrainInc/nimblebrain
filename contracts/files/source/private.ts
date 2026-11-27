/**
 * The private tools' schemas: the TypeBox authoring source for the `$defs`
 * entries of every tool `contract.ts` marks private. Only the host calls them
 * (CONTRACT.md §3).
 *
 * `contracts/scripts/emit-contracts.ts` turns this file into JSON, and
 * `--check` fails when the committed document differs. Nothing at runtime
 * imports this file.
 *
 * The byte flow (CONTRACT.md §7): the host puts an upload's body in the blob
 * store and calls `record`; to serve bytes it calls `resolve` and gets the
 * blob by the key it answers; it deletes the bodies `released` lists and
 * acknowledges them; at a workspace's purge it calls `delete_workspace`.
 *
 * Every private input is closed (`additionalProperties: false` at every level)
 * and carries the host's `version`. Outputs embed the public file record, which
 * stays open; the envelope around it is closed, because the host refuses what
 * it does not know (CONTRACT.md §14).
 */

import { Type } from "@sinclair/typebox";
import { FileRecord, ID_PATTERN, StringEnum } from "./public.ts";

const CLOSED = { additionalProperties: false } as const;

/** The version of this contract the host consumes, which bounds what the implementation answers. */
const Version = Type.String({
  pattern: "^1\\.(0|[1-9][0-9]*)$",
  description:
    "The version of this contract the host consumes. The answer holds nothing that version " +
    "does not define (CONTRACT.md §14).",
});

/** A blob key, in the blob store's grammar (CONTRACT.md §7). */
const BlobKey = Type.String({
  pattern: "^[a-z0-9][a-z0-9_-]{0,127}$",
  description:
    "A blob key under the workspace's scope in the blob store. Opaque: it names a body, never a path or an object.",
});

/** A `files://<id>` URI. */
export const FileUri = Type.String({
  pattern: `^files://${ID_PATTERN.slice(1, -1)}$`,
  description: "A file's URI: files://<id>, bare (CONTRACT.md §4).",
});

/** The most URIs one `resolve` answers. */
export const MAX_RESOLVE_URIS = 100;

/** The most keys one `released` page holds. */
export const MAX_RELEASED_PAGE = 1000;

/** The sources the host's doors record. `agent` is `create`'s alone. */
const HOST_SOURCES = ["chat", "app", "manual"] as const;

const Opaque = (description: string) => Type.String({ minLength: 1, maxLength: 512, description });

/** Every private tool: name → input and output schema. */
export const PRIVATE_SCHEMAS = {
  record: {
    input: Type.Object(
      {
        version: Version,
        blob: BlobKey,
        filename: Type.String({ minLength: 1, maxLength: 1024 }),
        mimeType: Type.String({ minLength: 1, maxLength: 255 }),
        size: Type.Integer({
          minimum: 0,
          description: "The stored body's size, as put answered it.",
        }),
        source: StringEnum(HOST_SOURCES, { description: "The door the body came through." }),
        conversationId: Type.Optional(
          Opaque("The conversation the file was attached in, minted before intake."),
        ),
        runId: Type.Optional(
          Opaque("The unattended run the body was stored for, when a run's door stored it."),
        ),
        folder: Type.Optional(
          Type.String({
            description:
              "Folder path, '/'-separated; missing levels are created, as create's manifest.folder.",
          }),
        ),
        tags: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        description: Type.Optional(Type.String({ maxLength: 4096 })),
      },
      CLOSED,
    ),
    output: Type.Object({ uri: FileUri, file: FileRecord }, CLOSED),
  },
  resolve: {
    input: Type.Object(
      {
        version: Version,
        uris: Type.Array(FileUri, { minItems: 1, maxItems: MAX_RESOLVE_URIS }),
      },
      CLOSED,
    ),
    output: Type.Object(
      {
        files: Type.Array(
          Type.Union([
            Type.Object(
              { uri: FileUri, found: Type.Literal(true), file: FileRecord, blob: BlobKey },
              CLOSED,
            ),
            Type.Object({ uri: FileUri, found: Type.Literal(false) }, CLOSED),
          ]),
          {
            maxItems: MAX_RESOLVE_URIS,
            description: "One entry per requested URI, in the order asked.",
          },
        ),
      },
      CLOSED,
    ),
  },
  released: {
    input: Type.Object(
      {
        version: Version,
        cursor: Type.Optional(
          Opaque(
            "The previous page's nextCursor. Passing it acknowledges every key on that page and the pages before it.",
          ),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RELEASED_PAGE })),
      },
      CLOSED,
    ),
    output: Type.Object(
      {
        blobs: Type.Array(BlobKey, {
          maxItems: MAX_RELEASED_PAGE,
          description: "Blob keys in the workspace that no record references and never will.",
        }),
        nextCursor: Type.Union([Opaque("Pass back to acknowledge this page."), Type.Null()], {
          description: "null exactly when `blobs` is empty.",
        }),
      },
      CLOSED,
    ),
  },
  delete_workspace: {
    input: Type.Object({ version: Version }, CLOSED),
    output: Type.Object(
      {
        removed: Type.Object(
          { files: Type.Integer({ minimum: 0 }), folders: Type.Integer({ minimum: 0 }) },
          CLOSED,
        ),
      },
      CLOSED,
    ),
  },
};
