# The files contract, `ai.nimblebrain.files` 1.0

An implementation of this contract keeps a deployment's files: their bytes, the record of each
file (its name, type, folder, tags and provenance), the catalog people and agents browse and
search, the text extracted from each body, and the screen. **The implementation owns its bytes
and its storage entirely; how and where it stores them is private to it.** The **host** (the
NimbleBrain runtime) takes every upload in at its doors and serves every body out, and decides
nothing about who may see a file: it asks the implementation. Bytes move between the two by
short-lived URLs the implementation issues (§7), never over MCP.

The contract is two things: this file, and one JSON document,
[`schemas/contracts/files/v1/contract.json`](../../schemas/contracts/files/v1/contract.json),
published at its `$id`. The document holds the identity, version, cardinality, every tool with
its visibility, unattended marking, annotations and its input and output schema, and the closed
list of errors. It is language-neutral. The TypeBox sources it is emitted from (`source/`) are
where it is authored, not part of it.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 1. Identity, location, cardinality, tools

```json
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nimblebrain.ai/contracts/files/v1/contract.json",
  "contract": "ai.nimblebrain.files", "version": "1.0", "cardinality": "singleton",
  "tools": { "read": { "visibility": "public", "unattended": "allowed",
                       "annotations": { "readOnlyHint": true },
                       "input": { "$ref": "#/$defs/read_input" },
                       "output": { "$ref": "#/$defs/read_output" } }, "…": {} },
  "errors": { "public": ["…"], "private": ["…"] },
  "$defs": { "read_input": {}, "read_output": {}, "…": {} } }
```

- **`contract`** is the identity: a permanent reverse-DNS name, the name a plugin's
  `implements[].contract` uses. **`$id`** is where the document lives, stated in it and never
  derived from `contract`.
- **`version`** is `major.minor` (§14). **`cardinality`** is `singleton`: an instance has at
  most one enabled implementation, and a host that finds two refuses to start.
- **An implementation is one MCP server.** It serves every tool the document names, each with
  the input and output schema its `$ref` names in `$defs`, listing the definition itself as the
  tool's `inputSchema` and `outputSchema`, and each public tool with the `annotations` its entry
  states. It MAY serve more; a client ignores what it does not know. No schema refers to
  another, so every tool's schema reads whole.
- **Each tool is `public` or `private`** (§3) **and `allowed` or `refused` unattended** (§9):

| Tool | Visibility | Unattended | Annotations | Operation |
|---|---|---|---|---|
| `list` | public | allowed | `readOnlyHint: true` | One page of the caller's files, in a folder or across all, filtered, sorted, counted |
| `search` | public | allowed | `readOnlyHint: true` | The caller's newest files whose name, description or tags hold a text |
| `info` | public | allowed | `readOnlyHint: true` | One file's record, without its body |
| `read` | public | allowed | `readOnlyHint: true` | One file's extracted text, whole or by page, up to a byte bound |
| `create` | public | allowed | `destructiveHint: false`, `idempotentHint: false` | Store a file whose content the caller sends |
| `tag` | public | allowed | `destructiveHint: true` | Add and remove a file's tags |
| `move` | public | allowed | `destructiveHint: true` | Move files into a folder, all or none |
| `delete` | public | allowed | `destructiveHint: true` | Delete a file and its bytes |
| `create_folder` | public | allowed | `destructiveHint: false` | Create a folder |
| `update_folder` | public | allowed | `destructiveHint: true` | Rename or move a folder |
| `delete_folder` | public | allowed | `destructiveHint: true` | Delete an empty folder |
| `begin_upload` | private | refused | — | Open an upload: answers its id and a short-lived upload URL |
| `complete_upload` | private | refused | — | Make the file from an upload's body: answers its URI and record |
| `resolve` | private | refused | — | Up to 100 URIs in the caller's scope: each found, with its record and a short-lived download URL, or absent |
| `delete_workspace` | private | refused | — | Purge every owner's files, folders and bytes in a workspace |

Every public tool that is not read-only is annotated `readOnlyHint: false` beside what the
table shows. A tool that removes or relocates anything (a tag, a file, a folder, a name) is
`destructiveHint: true`; one that only adds is `false`. A private tool carries no annotations: no agent sees it.

## 2. Scope and principal

**Every call carries the host context** ([`contracts/host-context/CONTEXT.md`](../host-context/CONTEXT.md)).
No schema in this contract has a workspace, owner or principal input. This contract reads
`principal`, `workspaceId`, `ownerId`, `conversationId`, `runId` and `unattended`.

- **Files are private to their owner.** Every public tool, `begin_upload`, `complete_upload`
  and `resolve` are walled to one workspace and one owner: a file belongs to the owner and
  workspace of the call that made it, and only that owner's calls in that workspace see it. An
  upload belongs to the owner and workspace of the `begin_upload` that opened it, and only a
  `complete_upload` in that scope completes it.
- **`delete_workspace` is walled to one workspace** and carries no owner: it removes every
  owner's files there.
- **Out of scope is indistinguishable from absent.** Another owner's or another workspace's
  file, folder or upload answers exactly as one that does not exist (`file_not_found`,
  `folder_not_found`, `upload_not_found`, left out of lists, `found: false` from `resolve`).
- **A call missing what its tool is walled to reads and writes nothing**: `scope_missing`.
- **Provenance comes from the context, never from arguments.** `create` and `begin_upload`
  record the context's `conversationId` and `runId` on the file they make (absent: `null`). The
  host stamps them on a `begin_upload` for a chat turn or a run as on any call it makes for
  one, after verifying the conversation is the caller's (§10).
- **Workspaces are the host's.** The implementation never decides whether a workspace exists;
  it creates whatever storage it needs on first use, and a workspace it holds nothing for reads
  as one with no files. Keeping files out of a deleted workspace is the host's invariant.
- **The principal** is `host` (the runtime) or `person` (a user, directly or through an agent or
  an app). A call that names no principal is not `host`. The host MAY call a public tool as
  `host`, walled to an owner, and it is answered as that owner's own call (§10 uses `read`,
  `list` and `delete` this way). A `host` call never carries `unattended`, and MAY carry `runId`
  and `conversationId` (host-context spec §7).

## 3. Public and private tools

**Public tools accept either principal. Private tools accept only `host`. A private tool called
by any other principal fails `forbidden`, checked before the input and the scope, and nothing
is read or written.** A host never offers private tools to agents and never lists them where
agents or MCP clients connect; the server's refusal is what makes them unreachable. A host MAY
expose the public tools under its own names (`files__<tool>`); the tools, schemas and behaviour
are unchanged.

## 4. Files, ids and the URI

- **A file is a record and a body**, both the implementation's. How it stores either, and how
  one names the other, is its own and never crosses the contract.
- **A file's id is minted by the implementation**, matches `^[a-z0-9][a-z0-9_-]{0,63}$`, is
  unique in the deployment, and is stable for the record's life. An id is never reused, so a
  link to a deleted file never reaches another one. A folder's id has the same grammar, and the
  top level is the id `root`, which names no folder record.
- **A file's URI is `files://<id>`**: bare, with no workspace and no owner in it. The workspace
  comes from the context of the call that reads it, and the owner from the identity in it, so
  the same URI resolves for its owner in its workspace and nowhere else. Public tools take the
  `id`; `complete_upload` answers the URI, and `resolve` takes URIs.
- **A file's body never changes.** There is no tool that rewrites content: a new body is a new
  file.
- **Folders are metadata.** Moving a file or a folder rewrites the record's place and touches no
  body. Sibling folder names are unique, compared case-insensitively. A record whose folder no
  longer exists reads as at the top level.
- **A folder name** is trimmed of surrounding space, and is then not empty, not `.` or `..`,
  and holds no `/` or `\`. A name that breaks this fails `invalid_input`.
- **A folder path** (`create`'s `manifest.folder`, `begin_upload`'s `folder`) is folder names
  joined by `/`, top first; `""` or an absent path is the top level. A path that begins or ends
  with `/`, or holds an empty segment (`a//b`, a segment of only spaces), fails
  `invalid_input`: no `/` is trimmed and no segment skipped, so one path names one place.

## 5. Behaviour and outputs

The public tools' behaviour, where a schema cannot state it.

- **`list`** filters on the server, so the page, `total` and `facets` describe one set. With
  `folderId` it answers that folder's files (and its subtree's with `recursive`), the folders in
  it and the breadcrumb; without it, files across every folder and the folders whose name
  matches `query`. `folders` is empty when a kind, source, provenance, date, tag or MIME filter
  is set. Each facet counts the matches for each value with every filter but its own. `total`,
  `facets`, `folders` and `breadcrumb` describe the whole set and are the same on every page.
- **`list` pages by an opaque cursor.** A page holds at most `limit` files (default 20), in the
  order `sort` and `order` name with the id breaking a tie, newest first by default.
  `nextCursor` is `null` on the last page. A client passes it back as `cursor` with the same
  filters and sort, unchanged, and never builds or parses one; a cursor passed with other
  filters fails `invalid_input`. Following the cursor never repeats or skips a file that
  existed when the first page was read; one added later MAY appear or be absent.
- **`search`** matches `query` case-insensitively as a substring of the filename, description
  and tags, and answers the newest up to `limit` (1 to 200, default 20), with `total` counting
  every match.
- **`create`** decodes `body` under `encoding` (base64 by default, verbatim UTF-8 with `text`),
  refuses base64 that is not the standard padded alphabet (`invalid_input`), and makes the file
  with `source: "agent"`, creating the folders `manifest.folder` names that do not exist (§4).
  It records the type **Types** (below) gives from `mimeType` and `filename`, which MUST be on
  the allowlist (§7), or the call fails `type_not_allowed`.
- **`tag`** answers the tags after the change; **`move`** moves every id or none; **`delete`**
  removes the file, after which it is absent everywhere and its bytes are the
  implementation's to remove (§7); **`delete_folder`** refuses a folder that holds files or
  folders (`conflict`).
- **`read`** is §8.

**Types.** A type is compared with its parameters (`;charset=…`) stripped, surrounding space
trimmed and case-folded; call that its bare type. `create` and `begin_upload` record a file's
type by the same rule, from the `mimeType` and `filename` they are given, and judge the
allowlist on the type recorded.

- **The recorded type.** When the bare `mimeType` is neither empty nor
  `application/octet-stream`, it is recorded as given, trimmed, with its case and parameters.
  Otherwise the filename's extension is the text after its last `.`, case-folded, and none
  when the name has no `.` or ends in one (`.env` has `env`; `Makefile` has none). A known
  extension records its type from the table below; any other, or none, records
  `application/octet-stream`.

  | Recorded type | Extensions |
  |---|---|
  | `text/markdown` | `md`, `markdown` |
  | `text/csv` | `csv` |
  | `text/html` | `html`, `htm` |
  | `application/json` | `json` |
  | `application/yaml` | `yaml`, `yml` |
  | `application/xml` | `xml` |
  | `text/plain` | `txt`, `text`, `log`, `jsonl`, `ndjson`, `typ`, `py`, `rb`, `go`, `rs`, `java`, `c`, `h`, `cpp`, `cc`, `hpp`, `cs`, `php`, `swift`, `kt`, `scala`, `sh`, `bash`, `zsh`, `sql`, `js`, `mjs`, `cjs`, `ts`, `tsx`, `jsx`, `css`, `scss`, `sass`, `less`, `toml`, `ini`, `cfg`, `conf`, `env`, `properties`, `tex`, `rst`, `adoc`, `org` |

- **A file's kind**, which `list`'s `kinds` filters and `facets.kinds` counts, follows from its
  bare type. For each type on the allowlist (§7):

  | Kind | Types |
  |---|---|
  | `image` | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml` |
  | `font` | `font/ttf`, `font/otf`, `font/woff`, `font/woff2` |
  | `data` | `text/csv`, `application/json`, `application/yaml`, `application/xml`, `text/xml`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
  | `document` | `application/pdf`, `text/plain`, `text/markdown`, `text/html`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
  | `other` | `text/yaml`, `application/zip`, `application/gzip`, `application/octet-stream` |

**Outputs.** A success carries its payload in `structuredContent`, valid against the tool's
output schema, and a readable rendering in `content`. `read` also carries a `resource_link`
block for `files://<id>` with the file's name, type and size, never the body.

- **Public inputs and outputs are open.** A client ignores an output field it does not know.
- **A value of a public output that names one of a set** (a record's `source`) is typed as a
  string whose description lists the values 1.0 defines, because a later minor may add one. A
  client shows a value it does not know verbatim and matches it to nothing.
- **Every private input and every private output envelope is closed**
  (`additionalProperties: false`). The file record inside a private output is the public one,
  open.

**The screen** is the resource `ui://files/browser`, MIME type `text/html;profile=mcp-app`. It
reads bodies through the host's `resources/read` of `files://` (§10), like any app. Its
internals and placement are the implementation's. The server advertises the resource template
`files://{id}`, so a view can open a file by URI (ADR-0052); it never answers `resources/read` of
a `files://` URI itself, which is always the host's.

## 6. Private tools

- **`begin_upload({ version, filename, mimeType, size, source, folder?, tags?, description?
  })`** opens an upload for a body of exactly `size` bytes, owned by the context's owner in its
  workspace, and answers `{ uploadId, url, method: "PUT", headers, expiresAt }`. `source` is
  the door the body comes through: `chat` (an attachment), `app` (an upload through an app or
  the REST door), `manual` (an upload a person made in the shell); `agent` is `create`'s alone.
  The file records the context's `conversationId` and `runId` (§2) and the type §5 **Types**
  gives. `folder` is a folder path (§4), checked here: a path that breaks §4's rule fails
  `invalid_input`. It fails `type_not_allowed` when the type recorded is off the allowlist and
  `too_large` for a `size` past the implementation's per-file limit. It makes no file: a file
  exists only once `complete_upload` answers.
- **`complete_upload({ version, uploadId })`** makes the file from the body last stored at the
  upload's URL and answers `{ uri, file }`, where `uri` is `files://<file.id>`. The
  implementation measures the stored body itself: absent, or of a length other than the
  declared `size`, it fails `upload_incomplete` and the upload stays open until it expires.
  Its **completion window** runs until 300 seconds after `expiresAt`: within it, a body whose
  PUT began before `expiresAt` completes. An unknown or out-of-scope `uploadId`, or one past
  that window, fails `upload_not_found`. The record's `size` is the measured length. A repeat
  for a completed upload is §12.
- **`resolve({ version, uris })`** answers, for each URI in the order asked, `{ uri, found:
  true, file, download: { url, expiresAt } }` when the URI names a file the context's owner may
  see in the workspace, and `{ uri, found: false }` otherwise. It is the one place visibility is
  decided: the host serves a body only after `resolve` found it, under the caller's own context,
  and fetches it from the URL it answered. A URI repeated in one call is answered at each place
  it appears.
- **`delete_workspace({ version })`** removes every owner's files, folders and open uploads in
  the workspace, their bytes, and any storage the implementation holds for it, and answers
  `removed`: the count of files and of folders it removed, across every owner. Open uploads
  are removed with their bytes and not counted. Idempotent: a repeat answers zero counts.

**Why completion is a tool call.** The upload URL may point at a store that runs none of the
implementation's code (a presigned object-store URL), so the PUT's answer cannot make the
record. `complete_upload` is the one commit point every medium has: the implementation
measures what arrived, makes the record and answers it to the host in one call, and a host that
stops between the PUT and the call leaves only an upload that expires.

## 7. Bytes

**The implementation holds every body and moves it by URL.** It decides where bodies live
(a directory, a bucket, a database) and what each URL points at (a listener of its own, a
presigned object-store URL). The host never reads or writes its storage and holds no
configuration for it.

**A transfer URL** is the `url` of `begin_upload`'s answer (an **upload URL**) or of a
`download` in `resolve`'s answer (a **download URL**). Every transfer URL:

- **is a bearer capability** for one operation on one body: an upload URL accepts only `PUT`
  of that upload's body, and a download URL answers only `GET` of that file's body. Holding it
  is the authority; it carries no other credential and needs none from the host.
- **is unguessable**: it holds at least 128 bits from a cryptographically secure source, or a
  signature under a key only the implementation holds.
- **expires soon, and says when**: `expiresAt` is at most 300 seconds after issue for a
  download URL and at most 900 seconds for an upload URL. A request begun before `expiresAt`
  runs to its end; one begun after is refused. An upload URL also stops accepting once its
  upload is completed. The host does not refuse a URL before trying it because of
  `expiresAt`; the URL's answer decides.
- **is absolute `http:` or `https:`**, at most 4096 characters, with no userinfo, on an
  origin the host is allowed to fetch from for the implementation's binding (§10). Which scheme
  a deployment uses is the deployment's choice.
- **MUST NOT appear** in a public output, an error, a log line, a span, the screen or any
  notification. It crosses only the private outputs above.

**What a URL serves.** A download URL answers `GET` with status 200, the file's exact body
streamed, unencoded, and its `Content-Length`. It MUST honour a single satisfiable range
(`Range: bytes=a-b`, `bytes=a-` or `bytes=-n`) with 206, `Content-Range` and that range's
`Content-Length`. A single range that starts at or past the body's end, a suffix of zero
bytes, or any range of an empty body answers 416. Any other `Range` (several ranges, or one it cannot parse) is ignored: 200
with the whole body. An upload URL accepts a `PUT` of the body with the `headers`
`begin_upload` named, and answers a 2xx once the body is stored. A PUT may be repeated until
the upload completes or expires; each replaces any earlier body, and `complete_upload`
measures the last one stored. A PUT longer than the declared `size` is refused with a 4xx
(413 where the implementation answers the PUT itself, an object store's own refusal
otherwise) and stores nothing: an earlier body stays as it was. After `delete` answers, no URL
issued since serves the file; one issued before serves it at most until it expires. That
window is unreachable from outside: only the host ever holds a download URL, and it fetches
from it at once after the `resolve` that answered it, under the caller's context.

**A local implementation** (one the host starts over stdio) serves its URLs from an HTTP
listener bound to a loopback address, on a port it chooses, started with the server. The
listener answers only `GET` of a live download token and `PUT` of a live upload token, and
answers every other request alike, with 404. It binds `127.0.0.1` or `::1` explicitly, never
`0.0.0.0` or `::`; compares tokens in constant time; keeps tokens out of its access logs; and
sends no CORS headers. An implementation the host reaches by URL serves its URLs from its own
origin, or from an origin its operator lists for its binding (an object store's, for presigned
URLs). It documents which origins it issues so the operator can list them.

**The host's side of a transfer:**

- It accepts only a URL valid against the rules above.
- **It fetches only from a destination the binding authorises**: the origin of the binding's
  own server URL, an origin the operator lists for the binding (exact scheme, host and port),
  or, for a binding the host starts over stdio, a loopback address on any port. Any other URL
  is a failed transfer, and the host sends it no request.
- **It checks the address it connects to.** It resolves the host once, refuses a name that
  resolves to a loopback, link-local, unspecified or multicast address, and connects to the
  address it checked. Loopback is reached only as a literal address, and only for a stdio
  binding.
- It follows no redirect: a 3xx answer is a failed transfer.
- It sends no credential, cookie or header of its own beyond `Content-Length`,
  `Accept-Encoding: identity`, on a `GET` an optional single `Range`, and on a `PUT` the
  `headers` `begin_upload` named. It refuses an upload whose `headers` name `Host`,
  `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `Expect`, `TE`, `Trailer`,
  `Keep-Alive`, `Cookie`, `Authorization` or any `Proxy-*` field, compared case-insensitively.
- A `GET` succeeds only on 200, or on 206 when the host sent a `Range`; a `PUT` only on a 2xx.
  Any other answer (a 416 among them) is a failed transfer, and so is an answer with a
  `Content-Encoding` other than `identity`.
- **Before it writes a byte onward**, the host checks that the answer's `Content-Length` is
  present and equals the record's `size` (for a 206, the range's length, with a
  `Content-Range` naming the range it asked for). It sets its own `Content-Length` from the
  record, counts while streaming, and aborts on an overrun or a short read. A failed transfer
  serves nothing.
- It never hands a transfer URL to an agent, an app, a browser or any client. A direct upload
  or download by a client is a later, explicit capability, not part of 1.0.

**The allowlist.** A file's type, compared with its parameters (`;charset=…`) stripped and
case-folded, is one of: `text/plain`, `text/csv`, `text/markdown`, `text/html`, `text/xml`,
`text/yaml`, `application/json`, `application/xml`, `application/yaml`,
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/pdf`,
`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml`, `application/zip`,
`application/gzip`, `font/ttf`, `font/otf`, `font/woff`, `font/woff2`,
`application/octet-stream`. The document's `create` input lists the same set. `create` and
`begin_upload` refuse any other (`type_not_allowed`), and the host's intake refuses it before
calling either.

**Removing bytes is the implementation's alone.** It removes a file's bytes after `delete`, a
workspace's after `delete_workspace`, and an upload's when it expires uncompleted; when is its
own. The host never deletes a body and has no way to.

**What crosses MCP, and its limits:**

| Crosses MCP | Limit |
|---|---|
| `create`'s `body`, inbound | at most 4 MiB (4,194,304 bytes) decoded; `too_large` beyond it |
| `read`'s text, outbound | at most `maxBytes`, and at most 1 MiB (1,048,576 bytes), of UTF-8 across `extractedText` or `pages` |
| records, folders, URIs, transfer URLs | as their schemas bound them |

**A server the host reaches over HTTP accepts an MCP request body of at least 8 MiB**
(8,388,608 bytes), so a `create` whose body is 4 MiB decoded fits as base64 with its envelope
and is answered by the tool (`too_large` past the limit), never refused by the transport.

**What never crosses MCP:** an upload's body, and every body the host serves (a download, a
`resources/read` of `files://`, a body rehydrated into a prompt, a connector's host-resources
read). Those move by transfer URL; `read` never answers a body, in base64 or any other form.

## 8. Extraction and `read`

**Extraction is the implementation's**, run in its own process, never the host's. In 1.0 it
covers at least the formats on the allowlist that hold text: every `text/*` type, JSON, XML
and YAML, PDF, DOCX and XLSX. An image, a font, an archive or other binary has no text.

- **Extraction is bounded by the text it keeps, not by the input.** The implementation sets its
  own bound on the text it answers (at most the 1 MiB of §7) and on the work an extraction may
  do (memory, pages, time), and refuses before parsing a body whose extraction would pass them.
  A refused or failed extraction is a body with no text, never a partial parse of one past its
  bound.
- **`read({ id, maxBytes? })`** answers the record's `id`, `filename`, `mimeType` and `size`,
  and `extractedText`: the text up to the lesser of `maxBytes` and the implementation's bound,
  cut at a character boundary, with `truncated` saying whether it stopped there, or `null` for
  a type with no text or an extraction that failed, with `truncated: false`. A failed
  extraction is not an error.
- **`read({ id, pages, maxBytes? })`** answers the text of those 1-based pages of a paged
  document (a PDF in 1.0), at most 10 a call: `totalPages`, `requestedPages` (sorted, each
  once), `missingPages` (past the end) and `pages[]` (`{ page, text, truncated, empty }` for
  each page that exists, in order), with `extractedText: null` and the top-level `truncated:
  false`, which describes `extractedText` alone. Each page's `truncated` says whether that
  page's text stopped at the bound. The pages' text together holds at most the same bound,
  spent in page order. A file with no pages fails `not_paged`; an extraction that fails
  fails `extraction_failed`.
- **The implementation MAY keep what it extracted** to answer the next `read` without parsing
  again. How is its own.

## 9. Unattended calls

- **Every public tool is `allowed`**: a run may read, write, file and delete its owner's files,
  since none of them sets up work that outlives the run. **Every private tool is `refused`.**
- The host stamps `unattended: true` and `runId` on every call a run makes, so a file a run
  creates carries the run. The host's own calls made for a run (`host` principal) carry `runId`
  and never `unattended`.

## 10. The host's obligations

The host owns intake and serving, and asks the implementation everything about records,
visibility and bytes.

1. **Files are off when nothing implements this contract.** With no enabled implementation,
   the host offers no `files__` tools, refuses attachments and uploads, and its file routes
   answer that files are disabled.
2. **One intake for every door.** A chat attachment, an upload through the REST door or the app
   bridge, and any later door take the same path:
   - The host checks what it can before opening any upload: the count, each body's size, the
     total, and the allowlist (§7).
   - Before it stamps a `conversationId` on `begin_upload`, the host verifies that the
     conversation is the caller's in this workspace. For a chat turn the conversation id is
     minted before intake, so every file's record names the conversation it was attached in.
   - For each body it calls `begin_upload` as `host`, walled to the workspace and the uploader,
     with the turn's `conversationId` or the run's `runId` in the context, streams exactly `size` bytes to the upload URL (§7), and calls `complete_upload`. It never
     holds a whole body in memory to measure it.
   - **The REST door is per file**: each file is taken in, or refused, on its own.
   - **A chat turn is all or none.** The host opens no upload until every file of the turn
     passes its checks, and completes none until every PUT has succeeded. If any PUT or
     `complete_upload` fails, it deletes, with `delete` as `host` walled to the uploader, every
     file of the turn already completed, and the turn is refused. The uploads it never
     completed expire.
3. **The model's view of an attachment.** For a file whose type has text, the host calls `read`
   as `host`, walled to the uploader, with a `maxBytes` of its choosing, and puts the text in
   the message; an image or a PDF travels as a `resource_link` to its `files://` URI. The host
   runs no parser.
4. **Serving bytes, at every door, through `resolve`.** The browser download door,
   `resources/read` of a `files://` URI at the MCP door and the app bridge, an image or a PDF
   rehydrated into a model's prompt, and a connector's host-resources read: each calls
   `resolve` as `host` with the caller's own workspace and owner, and, when the file is found,
   streams the body from its download URL. Absent is not found, at every door alike. Every
   door names the workspace it serves from; none locates a file without one.
   - The host serves the body with its own headers and passes none of the URL's answer through
     but its length and, for a range, its `Content-Range`. The browser download door supports
     `Range` by passing a single range through to the download URL. On that door: `Content-Type` the record's type when it is on the
     allowlist and `application/octet-stream` otherwise, `X-Content-Type-Options: nosniff`, a
     sandboxing `Content-Security-Policy`, `Content-Length` from the answer, and a
     `Content-Disposition` whose filename the host sanitised (no control characters, quotes or
     path separators; RFC 6266 `filename*`). It never writes the record's filename or type into
     a header unchecked.
   - A model that cannot take a PDF's bytes gets its text from `read` instead. The listings
     these doors offer (`resources/list` of files, a connector's host-resources list) come from
     `list`.
5. **`filesWritten` for tasks.** The host records the files a run wrote from its own record of
   the `create` calls the run made to this contract: for each that succeeded, the URI
   `files://<id>` and the `filename` from that call's output. It never parses any other tool's
   output for files.
6. **Purging a workspace.** Before it calls `delete_workspace`, the host refuses every files
   call for that workspace at every door, so nothing is written there while the purge runs. It
   then calls `delete_workspace`, and the implementation removes the workspace's files and
   bytes. The implementation only ever purges when the host says so.
7. **The context.** The host stamps `conversationId` during a chat turn and `runId` during a run
   on every call it makes for them, and overwrites any a caller supplied. A `host` call never
   carries `unattended`.
8. **Transfer URLs stay inside the host** (§7): it never logs one, shows one or passes one on.
9. **Transfer destinations are the operator's.** A binding authorises its own server's
   origin, the origins its operator lists for it, and, when the host starts it over stdio,
   loopback. Nothing else. The host enforces this on the resolved address (§7). The list, and
   whether a destination needs TLS, are host configuration, not fields of this contract.

## 11. Errors

The document's `errors` is the closed list. A failed call writes nothing.

- **Public tools, and a tool name the server does not have**: `isError: true`, text JSON
  `{ code, error }`. `code` is one of `file_not_found`, `folder_not_found`, `conflict`,
  `not_paged`, `extraction_failed`, `too_large`, `type_not_allowed`, `scope_missing`,
  `invalid_input`, `unknown_tool`, and `error` begins with that code's prefix in
  `errors.public`. A caller decides on `code`, never on the text.
- **Private tools**: `isError: true`, text JSON `{ code, error }`. `code` is one of
  `forbidden`, `invalid_input`, `scope_missing`, `too_large`, `type_not_allowed`,
  `upload_not_found`, `upload_incomplete`, `internal_error`. `error` is diagnostic only. A URI
  `resolve` cannot find is an answer (`found: false`), not an error.
- No error carries a transfer URL or names where a body is stored.
- A refusal before any tool runs (a missing credential, `context_mismatch`) is the transport's.

## 12. Idempotency

- **`complete_upload` is idempotent per upload.** A repeat for an upload already completed
  answers the first call's `{ uri, file }` unchanged (a tag or a move since does not change
  it) and makes nothing, while both hold: the file exists, and the upload's completion window
  (§6) lasts. Once the file is deleted, or the window has passed, a repeat fails
  `upload_not_found`. The host MAY retry `complete_upload` within the window, and a host that
  lost an answer retries it safely.
- **`begin_upload` is not idempotent**: each call opens a new upload. One never completed
  expires and its bytes are removed (§7).
- **`create` is not idempotent**: each call makes a new file.
- `delete` and `delete_folder` fail `file_not_found` and `folder_not_found` for what is absent.
  `delete_workspace` is idempotent.

## 13. Never in the contract

- **The storage.** No path, file handle, query, table, bucket, object key or layout crosses the
  contract, and the host holds no configuration for it. A transfer URL is opaque to the host.
- **Bodies on MCP** beyond §7's table.
- **The host's serving machinery**: routes and their paths, caches, timeouts.
- **Sharing.** A file is its owner's alone in 1.0. Visibility beyond the owner is a later minor,
  decided in `resolve`, never by widening the host's reads.
- **Direct transfers by a client.** A transfer URL reaches no agent, app or browser in 1.0.
- **Archive, restore and retention.** A workspace's files are purged when the host says so and
  not before; any window before that is the host's.
- **Credentials and the carriage of the context**, which the host-context spec owns.

## 14. Versioning

- The version is `major.minor`. The document's URL names the major (`…/files/v1/…`).
- **The same major is compatible.** An implementation at `M.m` meets a need for `N.n` when
  `M = N` and `m >= n`. A host states the minor it needs and refuses an implementation below
  it.
- **A minor only adds**: an optional input field, an output field, a tool, an error code, a
  resource, a paged type for `read`, a type on the allowlist, a value of a public output's
  string set (§5).
- **Versioning holds both ways.** Every private input carries the host's `version`, and an
  implementation MUST NOT answer a field that version does not define in a private output.
- **Anything else is a new major**, at its own URL beside this one.

## 15. Differences from the files tools these replace

The public tools keep the names, inputs and outputs agents and the screen use. Every
difference:

- **`read_pdf_pages` is folded into `read`.** `read` takes an optional `pages` (the same 1-based
  list, at most 10) and, with it, answers `totalPages`, `requestedPages`, `missingPages` and
  `pages` beside the record's fields, with `extractedText: null`. Its errors are `not_paged` and
  `extraction_failed`.
- **`read` takes an optional `maxBytes`** (1 to 1 MiB) that bounds the text it answers.
- **`list` pages by an opaque cursor.** `offset` is gone; `cursor` is an input and `nextCursor`
  an output. `total` and `facets` are unchanged.
- **`search`'s `limit` is an integer from 1 to 200.**
- **`create`'s body is bounded** at 4 MiB decoded (`too_large`), and its type must be on the
  allowlist (`type_not_allowed`), the same one every door's intake enforces.
- **Errors are `{ code, error }`** with the closed codes of §11, not a bare `{ error }`. The
  texts keep `File not found: ` and `Folder not found: `; a taken folder name, a folder moved
  into itself and a non-empty folder are `Conflict: …`; a bad base64 body is
  `Invalid arguments for "create": …`.
- **Annotations are stated for every tool**: `destructiveHint: true` on `tag`, `move`,
  `update_folder`, `delete` and `delete_folder`, `destructiveHint: false` on `create` and
  `create_folder`, and `idempotentHint: false` on
  `create`.
- **Ids are the implementation's.** A folder id is matched by the grammar of §4 instead of one
  implementation's `fd_` and 24 hex characters.
- **A record's `source` is an open string** in outputs (its four values unchanged), and the
  record carries no `deleted` or `deletedAt`, which a live record never had set.
- **`runId` comes from the host context** (`runId`, host-context spec §5).
- **Sizes are integers**: a record's `size`, `read`'s and `create`'s are `integer`, at least 0.
- **The host's doors change with it** (not tools of this contract): every door that serves a
  file names its workspace, because `resolve` is walled to the workspace in the caller's
  context; an attachment's text reaches the prompt through `read`.

## 16. Conformance

The conformance runner speaks only MCP (and HTTP to the transfer URLs it is answered) to an
implementation and reads only this document. An implementation is conformant when it holds
every rule this file states; the runner checks at least:

- every tool's schemas and annotations, the walls (owner and workspace), and the principal rule
  (each private tool answers a `person` with `forbidden`);
- that `resolve` called as `host` with a `runId` in the context succeeds;
- an upload end to end: `begin_upload`, a PUT of the body, `complete_upload`, then `resolve`
  and a GET of the download URL answer the same bytes; `upload_incomplete` for a missing or
  short body; a repeated PUT replacing the earlier body; a PUT past the declared size refused
  and storing nothing; a single `Range` answered 206 with `Content-Range`, several ranges
  answered 200 whole and an unsatisfiable one 416; `upload_not_found` for another owner's
  upload; `complete_upload` idempotent, `upload_not_found` once its file is deleted, and
  succeeding up to 300 seconds past `expiresAt` for a PUT begun before it; `type_not_allowed`
  and `too_large` from `begin_upload`, its type recorded by §5 **Types**, and `invalid_input`
  for a folder path §4 refuses;
- that every transfer URL meets §7 (scheme, expiry bound, one operation: a download URL refuses
  `PUT`, an upload URL refuses `GET`), and that none answers a redirect;
- that `create`'s body round-trips unchanged through `resolve` and its download URL,
  a body of exactly 4 MiB stored, `too_large` past it (with a request of nearly 8 MiB answered
  by the tool), `type_not_allowed` off the allowlist, `invalid_input` for unpadded or base64url
  bodies and for a folder path §4 refuses;
- `resolve` found for the owner and absent for another owner, another workspace and a deleted
  file, and that no download URL issued after `delete` serves the body;
- `list`'s cursor (every file once across pages, `invalid_input` for a cursor with other
  filters), `read`'s bound and `maxBytes`, pages (the top-level `truncated` false, each page's
  its own), `not_paged`;
- that no public output, error or screen carries a transfer URL or a body;
- that the server answers no `resources/read` of a `files://` URI;
- that every private answer is valid against its closed schema at the stated `version`.

**Timing cases.** The cases that wait for a transfer URL to expire run only when the
implementation issues URLs that expire within 15 seconds of issue; otherwise the runner skips
each, saying why. An implementation MAY offer URL lifetimes shorter than §7's bounds, as an
option for testing or any other reason: any lifetime within those bounds conforms. The case
that an upload past its completion window is `upload_not_found` waits 300 seconds past
`expiresAt`, so it runs only when the runner is asked to wait, and is skipped, saying so,
otherwise.

The document is also held by unit tests: it compiles whole as JSON Schema 2020-12, every
`$ref` resolves, every tool carries its markings and every public one its annotations, every
public tool is allowed unattended and every private one refused, the private inputs carry
`version`, transfer URLs appear only in private outputs, and nothing names a blob key or a
storage location.

Generate types for another language from the document's `$defs`; never write them by hand.
