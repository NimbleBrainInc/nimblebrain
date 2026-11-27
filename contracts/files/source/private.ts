/**
 * The private tools' schemas: the TypeBox authoring source for the `$defs`
 * entries of every tool `contract.ts` marks private. Only the host calls them
 * (CONTRACT.md §3).
 *
 * `contracts/scripts/emit-contracts.ts` turns this file into JSON, and
 * `--check` fails when the committed document differs. Nothing at runtime
 * imports this file.
 *
 * The byte flow (CONTRACT.md §7): bytes move by short-lived URLs the
 * implementation issues, never over MCP. To take an upload in, the host calls
 * `begin_upload`, streams the body to the upload URL it answers, and calls
 * `complete_upload`. To serve a file, it calls `resolve` and streams the body
 * from the download URL it answers. Where the URLs point, and how the bytes
 * are stored, is the implementation's.
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

/** A `files://<id>` URI. */
export const FileUri = Type.String({
  pattern: `^files://${ID_PATTERN.slice(1, -1)}$`,
  description: "A file's URI: files://<id>, bare (CONTRACT.md §4).",
});

/** The most URIs one `resolve` answers. */
export const MAX_RESOLVE_URIS = 100;

/** The latest a download URL may expire, in seconds after it is issued (CONTRACT.md §7). */
export const MAX_DOWNLOAD_TTL_SECONDS = 300;

/** The latest an upload URL may expire, in seconds after it is issued (CONTRACT.md §7). */
export const MAX_UPLOAD_TTL_SECONDS = 900;

/** The longest transfer URL either tool answers. */
const MAX_URL_LENGTH = 4096;

/** The most headers an upload names for the host to send. */
const MAX_UPLOAD_HEADERS = 16;

/** An HTTP field name: an RFC 9110 token. */
const HEADER_NAME_PATTERN = "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$";

/** An HTTP field value: visible ASCII, space, tab and obs-text; never CR, LF or NUL. */
const HEADER_VALUE_PATTERN = "^[\\t\\x20-\\x7e\\x80-\\xff]*$";

/** The sources the host's doors record. `agent` is `create`'s alone. */
const HOST_SOURCES = ["chat", "app", "manual"] as const;

const Opaque = (description: string) => Type.String({ minLength: 1, maxLength: 512, description });

/** A transfer URL: a bearer capability for one operation on one file (CONTRACT.md §7). */
const TransferUrl = (description: string) =>
  Type.String({
    minLength: 1,
    maxLength: MAX_URL_LENGTH,
    pattern: "^https?://",
    description:
      `${description} An absolute http(s) URL and a bearer capability: it MUST NOT appear in ` +
      "a public output, an error, a log or the screen (CONTRACT.md §7).",
  });

const ExpiresAt = (bound: number) =>
  Type.String({
    format: "date-time",
    description: `When the URL stops accepting a request (RFC 3339): at most ${bound} seconds after it was issued. A request begun before it runs to its end.`,
  });

/** Every private tool: name → input and output schema. */
export const PRIVATE_SCHEMAS = {
  begin_upload: {
    input: Type.Object(
      {
        version: Version,
        filename: Type.String({ minLength: 1, maxLength: 1024 }),
        mimeType: Type.String({
          minLength: 1,
          maxLength: 255,
          description: "The body's type, on the allowlist (CONTRACT.md §7).",
        }),
        size: Type.Integer({
          minimum: 0,
          description: "The body's exact length in bytes. The host sends exactly this many.",
        }),
        source: StringEnum(HOST_SOURCES, { description: "The door the body comes through." }),
        folder: Type.Optional(
          Type.String({
            description:
              "Folder path, '/'-separated; missing levels are created at completion, as create's manifest.folder.",
          }),
        ),
        tags: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        description: Type.Optional(Type.String({ maxLength: 4096 })),
      },
      CLOSED,
    ),
    output: Type.Object(
      {
        uploadId: Opaque("Names this upload to complete_upload."),
        url: TransferUrl(
          "Where the host PUTs the body. A repeated PUT replaces the earlier body until the upload completes or expires.",
        ),
        method: Type.Literal("PUT"),
        headers: Type.Record(
          Type.String({ pattern: HEADER_NAME_PATTERN }),
          Type.String({ maxLength: 1024, pattern: HEADER_VALUE_PATTERN }),
          {
            additionalProperties: false,
            propertyNames: { minLength: 1, maxLength: 128 },
            maxProperties: MAX_UPLOAD_HEADERS,
            description:
              "Headers the host sends with the PUT, verbatim, beside its own Content-Length. Part of the capability. The host refuses an upload whose headers name a field it owns (CONTRACT.md §7).",
          },
        ),
        expiresAt: ExpiresAt(MAX_UPLOAD_TTL_SECONDS),
      },
      CLOSED,
    ),
  },
  complete_upload: {
    input: Type.Object(
      { version: Version, uploadId: Opaque("The uploadId begin_upload answered.") },
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
              {
                uri: FileUri,
                found: Type.Literal(true),
                file: FileRecord,
                download: Type.Object(
                  {
                    url: TransferUrl("Where the host GETs this file's body."),
                    expiresAt: ExpiresAt(MAX_DOWNLOAD_TTL_SECONDS),
                  },
                  CLOSED,
                ),
              },
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
