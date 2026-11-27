# The files contract, `ai.nimblebrain.files` 1.0

An implementation of this contract keeps a deployment's files: the record of each file (its
name, type, folder, tags and provenance), the catalog people and agents browse and search, the
text extracted from each body, and the screen. The **host** (the NimbleBrain runtime) takes
every upload in, serves every large body out, and decides nothing about who may see a file: it
asks the implementation. The bodies themselves live in the blob store (§7), which the host and
the implementation share.

The contract is two things: this file, and one JSON document,
[`schemas/contracts/files/v1/contract.json`](../../schemas/contracts/files/v1/contract.json),
published at its `$id`. The document holds the identity, version, cardinality, every tool with
its visibility, unattended marking and its input and output schema, and the closed list of
errors. It is language-neutral. The TypeBox sources it is emitted from (`source/`) are where it
is authored, not part of it.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 1. Identity, location, cardinality, tools

```json
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nimblebrain.ai/contracts/files/v1/contract.json",
  "contract": "ai.nimblebrain.files", "version": "1.0", "cardinality": "singleton",
  "tools": { "read": { "visibility": "public", "unattended": "allowed",
                       "input": { "$ref": "#/$defs/read_input" },
                       "output": { "$ref": "#/$defs/read_output" } }, "…": {} },
  "errors": { "public": ["…"], "private": ["…"] },
  "$defs": { "read_input": {}, "read_output": {}, "…": {} } }
```

- **`contract`** is the identity: a permanent reverse-DNS name, the name a plugin's
  `implements[].contract` uses. **`$id`** is where the document lives, stated in it and never
  derived from `contract`.
- **`version`** is `major.minor` (§13). **`cardinality`** is `singleton`: an instance has at
  most one enabled implementation, and a host that finds two refuses to start.
- **An implementation is one MCP server.** It serves every tool the document names, each with
  the input and output schema its `$ref` names in `$defs`, listing the definition itself as the
  tool's `inputSchema` and `outputSchema`. It MAY serve more; a client ignores what it does not
  know. No schema refers to another, so every tool's schema reads whole.
- **Each tool is `public` or `private`** (§3) **and `allowed` or `refused` unattended** (§9):

| Tool | Visibility | Unattended | Operation |
|---|---|---|---|
| `list` | public | allowed | One page of the caller's files, in a folder or across all, filtered, sorted, counted |
| `search` | public | allowed | The caller's newest files whose name, description or tags hold a text |
| `info` | public | allowed | One file's record, without its body |
| `read` | public | allowed | One file's extracted text, whole or by page |
| `create` | public | allowed | Store a file whose content the caller sends |
| `tag` | public | allowed | Add and remove a file's tags |
| `move` | public | allowed | Move files into a folder, all or none |
| `delete` | public | allowed | Delete a file |
| `create_folder` | public | allowed | Create a folder |
| `update_folder` | public | allowed | Rename or move a folder |
| `delete_folder` | public | allowed | Delete an empty folder |
| `record` | private | refused | Record a file whose body the host stored; answers its URI and record |
| `resolve` | private | refused | Up to 100 URIs in the caller's scope: each found, with its record and blob key, or absent |
| `released` | private | refused | One page of blob keys no record references, acknowledged by passing the cursor back |
| `delete_workspace` | private | refused | Purge every owner's files and folders in a workspace |

## 2. Scope and principal

**Every call carries the host context** ([`contracts/host-context/CONTEXT.md`](../host-context/CONTEXT.md)).
No schema in this contract has a workspace, owner or principal input. This contract reads
`principal`, `workspaceId`, `ownerId`, `conversationId`, `runId` and `unattended`.

- **Files are private to their owner.** Every public tool, `record` and `resolve` are walled to
  one workspace and one owner: a file belongs to the owner and workspace of the call that made
  it, and only that owner's calls in that workspace see it.
- **`released` and `delete_workspace` are walled to one workspace** and carry no owner: they
  read or write every owner's records there.
- **Out of scope is indistinguishable from absent.** Another owner's or another workspace's
  file or folder answers exactly as one that does not exist (`file_not_found`,
  `folder_not_found`, left out of lists, `found: false` from `resolve`).
- **A call missing what its tool is walled to reads and writes nothing**: `scope_missing`.
- **Provenance comes from the context, never from arguments.** `create` records the context's
  `conversationId` and `runId` on the file it makes (absent: `null`). `record` takes the
  conversation and the run from its input, because the host stored the body for them (§10).
- **Workspaces are the host's.** The implementation never decides whether a workspace exists;
  it creates whatever storage it needs on first use, and a workspace it holds nothing for reads
  as one with no files. Keeping files out of a deleted workspace is the host's invariant.
- **The principal** is `host` (the runtime) or `person` (a user, directly or through an agent or
  an app). A call that names no principal is not `host`. The host MAY call a public tool as
  `host`, walled to an owner, and it is answered as that owner's own call (§10 uses `read` and
  `list` this way).

## 3. Public and private tools

**Public tools accept either principal. Private tools accept only `host`. A private tool called
by any other principal fails `forbidden`, checked before the input and the scope, and nothing
is read or written.** A host never offers private tools to agents and never lists them where
agents or MCP clients connect; the server's refusal is what makes them unreachable. A host MAY
expose the public tools under its own names (`files__<tool>`); the tools, schemas and behaviour
are unchanged.

## 4. Files, ids and the URI

- **A file is a record and a body.** The record is the implementation's; the body is a blob,
  held under the workspace's scope and a key (§7). Every record references exactly one blob key,
  and one blob key is referenced by at most one record.
- **A file's id is minted by the implementation**, matches `^[a-z0-9][a-z0-9_-]{0,63}$`, is
  unique in the deployment, and is stable for the record's life. An id is never reused, so a
  link to a deleted file never reaches another one. A folder's id has the same grammar, and the
  top level is the id `root`, which names no folder record.
- **A file's URI is `files://<id>`**: bare, with no workspace and no owner in it. The workspace
  comes from the context of the call that reads it, and the owner from the identity in it, so
  the same URI resolves for its owner in its workspace and nowhere else. Public tools take the
  `id`; `record` answers the URI, and `resolve` takes URIs.
- **A file's body never changes.** There is no tool that rewrites content: a new body is a new
  file.
- **Folders are metadata.** Moving a file or a folder rewrites the record's place and touches no
  body. Sibling folder names are unique, compared case-insensitively. A record whose folder no
  longer exists reads as at the top level.

## 5. Behaviour and outputs

The public tools' behaviour, where a schema cannot state it.

- **`list`** filters on the server, so the page, `total` and `facets` describe one set. With
  `folderId` it answers that folder's files (and its subtree's with `recursive`), the folders in
  it and the breadcrumb; without it, files across every folder and the folders whose name
  matches `query`. `folders` is empty when a kind, source, provenance, date, tag or MIME filter
  is set. Each facet counts the matches for each value with every filter but its own. It pages
  by `offset` and `limit`, newest first by default.
- **`search`** matches `query` case-insensitively as a substring of the filename, description
  and tags, and answers the newest up to `limit`, with `total` counting every match.
- **`create`** decodes `body` under `encoding` (base64 by default, verbatim UTF-8 with `text`),
  refuses base64 that is not the standard padded alphabet (`invalid_input`), stores the body
  (§7), and makes the record with `source: "agent"`, creating the folders `manifest.folder`
  names that do not exist. A generic `application/octet-stream` or empty `mimeType` for a known
  text or source extension is recorded as that extension's text type; a specific type is kept
  as given.
- **`tag`** answers the tags after the change; **`move`** moves every id or none; **`delete`**
  removes the record, after which the file is absent everywhere and its blob key is released
  (§7); **`delete_folder`** refuses a folder that holds files or folders (`conflict`).
- **`read`** is §8.

**Outputs.** A success carries its payload in `structuredContent`, valid against the tool's
output schema, and a readable rendering in `content`. `read` also carries a `resource_link`
block for `files://<id>` with the file's name, type and size, never the body. `list`, `search`,
`info` and `read` are annotated `readOnlyHint: true`.

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

- **`record({ version, blob, filename, mimeType, size, source, conversationId?, runId?, folder?,
  tags?, description? })`** makes the record of a body the host stored under the workspace's scope at
  `blob`, owned by the context's owner, and answers `{ uri, file }`. `source` is the door the
  body came through: `chat` (an attachment), `app` (an upload through an app or the REST door),
  `manual` (an upload a person made in the shell); `agent` is `create`'s alone. `conversationId` and `runId` are what
  the host stored the body for, `null` on the record when absent. `folder` is a path, as
  `create`'s. The implementation trusts `size` and `mimeType` as the host measured and
  checked them.
- **`resolve({ version, uris })`** answers, for each URI in the order asked, `{ uri, found:
  true, file, blob }` when the URI names a file the context's owner may see in the workspace,
  and `{ uri, found: false }` otherwise. It is the one place visibility is decided: the host
  serves a body only after `resolve` found it, under the caller's own context, and reads it at
  the key it answered. A URI repeated in one call is answered at each place it appears.
- **`released({ version, cursor?, limit? })`** answers a page of blob keys in the workspace that
  no record references and none ever will again: the bodies of deleted files, and any body the
  implementation stored for a record it never made (§7). It answers `nextCursor`, `null`
  exactly when `blobs` is empty.
  - **Passing `cursor` acknowledges** every key on the page that answered it and on every page
    before it. The implementation then MAY forget those keys and never lists them again.
  - **Until acknowledged, a key is listed again** by every `released` call that starts without a
    cursor, so a host that stops between deleting and acknowledging repeats the delete, which
    is idempotent.
  - At most `limit` keys a page (default 100, at most 1000).
- **`delete_workspace({ version })`** purges every owner's files and folders in the workspace
  and any storage the implementation holds for it, and answers what it removed. Idempotent. It
  releases nothing: the host deletes the workspace's whole blob scope after it (§10).

## 7. Bytes

**Bodies live in the blob store** (the kernel's blob provider, `src/providers/blobs/types.ts`
in the NimbleBrain repository): write-once bodies under a scope and a key. For a file's body
the scope is the workspace id, and the key matches `^[a-z0-9][a-z0-9_-]{0,127}$`, minted at
random by the party that puts the body and never reused.

- **One store, configured for both.** The operator gives the same store's location to the host
  and to the implementation. The implementation opens it with an implementation of the same
  provider in its own language, held to the provider's rules and its published layout, so a
  body either side puts the other gets, locally (one directory) and at scale (one bucket both
  reach). The location is configuration, never an argument of this contract.
- **One owner per body.** The party holding the bytes puts them, once: the host an upload's body
  (before `record`), the implementation `create`'s body. **Only the host deletes**: the keys
  `released` lists, a body whose `record` failed, and a purged workspace's whole scope. The
  implementation MUST NOT delete a body.
- **Every key the implementation puts reaches a record or `released`.** It MUST note a key
  before putting the body under it, so a `create` that stores a body and fails to make its
  record (an error, a crash) lists that key in `released`.
- **A blob key is the store's name for a body**, opaque and medium-neutral. It is never a path,
  a bucket or an object key: the provider maps it to its medium. It crosses only the private
  tools (`record`'s input, `resolve`'s answer, `released`'s pages) and MUST NOT appear in a
  public output, an error or the screen.

**What crosses MCP, and its limits:**

| Crosses MCP | Limit |
|---|---|
| `create`'s `body`, inbound | at most 4 MiB (4,194,304 bytes) decoded; `too_large` beyond it |
| `read`'s text, outbound | at most 1 MiB (1,048,576 bytes) of UTF-8, across `extractedText` or `pages` |
| records, folders, URIs, blob keys | as their schemas bound them |

**What never crosses MCP:** an upload's body, and every body the host serves (a download, a
`resources/read` of `files://`, a body rehydrated into a prompt, a connector's host-resources
read). The host puts and gets those in the blob store; the implementation never sends or
receives a body over MCP, and `read` never answers one, in base64 or any other form.

## 8. Extraction and `read`

**Extraction is the implementation's**, run in its own process, never the host's. In 1.0 it
covers at least the formats the host's intake accepts as text: every `text/*` type, JSON, XML
and YAML, PDF, DOCX and XLSX. An image, a font, an archive or other binary has no text.

- **Extraction is bounded by the text it keeps, not by the input.** The implementation sets its
  own bound on the text it answers (at most the 1 MiB of §7) and on the work an extraction may
  do (memory, pages, time), and refuses before parsing a body whose extraction would pass them.
  A refused or failed extraction is a body with no text, never a partial parse of one past its
  bound.
- **`read({ id })`** answers the record's `id`, `filename`, `mimeType` and `size`, and
  `extractedText`: the text up to the bound, with `truncated` saying whether it stopped there,
  or `null` for a type with no text or an extraction that failed. A failed extraction is not an
  error.
- **`read({ id, pages })`** answers the text of those 1-based pages of a paged document (a PDF
  in 1.0), at most 10 a call: `totalPages`, `requestedPages` (sorted, each once),
  `missingPages` (past the end) and `pages[]` (`{ page, text, truncated, empty }` for each page
  that exists, in order), with `extractedText: null`. A file with no pages fails `not_paged`; an
  extraction that fails fails `extraction_failed`.
- **The implementation MAY keep what it extracted** to answer the next `read` without parsing
  again. How is its own.

## 9. Unattended calls

- **Every public tool is `allowed`**: a run may read, write, file and delete its owner's files,
  since none of them sets up work that outlives the run. **Every private tool is `refused`.**
- The host stamps `unattended: true` on every call a run makes, and `runId` with it, so a file
  a run creates carries the run.

## 10. The host's obligations

The host owns intake and serving, and asks the implementation everything about records and
visibility.

1. **One intake for every door.** A chat attachment, an upload through the REST door or the app
   bridge, and any later door take the same path:
   - The host checks what it can before storing anything: the count, the declared sizes, the
     total, and the type allowlist. For a chat turn the conversation id is minted before
     intake, so every file's record names the conversation it was attached in.
   - It streams each body into the blob store under the workspace's scope and a fresh key, with
     `maxBytes` the per-file limit, so a body past it is abandoned unstored. It never holds a
     whole body in memory to measure it.
   - It calls `record` as `host`, walled to the workspace and the uploader, with the size the
     store answered. When `record` fails, it deletes the body.
   - A chat turn is all or none: if any of its files is refused, the host deletes every body it
     stored for the turn and records none.
2. **The model's view of an attachment.** For a file whose type has text, the host calls `read`
   as `host`, walled to the uploader, and puts the text in the message; an image or a PDF
   travels as a `resource_link` to its `files://` URI. The host runs no parser.
3. **Serving large bytes, at every door, through `resolve`.** The browser download route
   (`GET /v1/workspaces/:workspaceId/files/:id`), `resources/read` of a `files://` URI at the MCP
   door and the app bridge, an image or a PDF rehydrated into a model's prompt, and a
   connector's host-resources read: each calls `resolve` as `host` with the caller's own
   workspace and owner, and, when the file is found, gets the body from the blob store under
   that workspace's scope at the key `resolve` answered. Absent is not found, at every door
   alike. The host serves the body with the record's type and name and its own headers (a
   sandboxing content policy for the download route); a model that cannot take a PDF's bytes
   gets its text from `read` instead. The listings these doors offer (`resources/list` of
   files, a connector's host-resources list) come from `list`.
4. **`filesWritten` for tasks.** The host records the files a run wrote from its own record of
   the `create` calls the run made to this contract: for each that succeeded, the URI
   `files://<id>` and the `filename` from that call's output. It never parses any other tool's
   output for files.
5. **Releasing.** The host calls `released` for each workspace it serves, on an interval of its
   choosing, deletes each key it lists, and passes the cursor back once those deletes have
   succeeded.
6. **Purging a workspace.** When the host purges a workspace, it calls `delete_workspace` and
   then deletes the workspace's whole blob scope. The implementation only ever purges when the
   host says so.
7. **The context.** The host stamps `conversationId` during a chat turn and `runId` during a run
   on every call it makes for them, and overwrites any a caller supplied.

## 11. Errors

The document's `errors` is the closed list. A failed call writes nothing.

- **Public tools, and a tool name the server does not have**: `isError: true`, text JSON
  `{ code, error }`. `code` is one of `file_not_found`, `folder_not_found`, `conflict`,
  `not_paged`, `extraction_failed`, `too_large`, `scope_missing`, `invalid_input`,
  `unknown_tool`, and `error` begins with that code's prefix in `errors.public`. A caller
  decides on `code`, never on the text.
- **Private tools**: `isError: true`, text JSON `{ code, error }`. `code` is one of
  `forbidden`, `invalid_input`, `scope_missing`, `internal_error`. `error` is diagnostic only.
  A URI `resolve` cannot find is an answer (`found: false`), not an error.
- A refusal before any tool runs (a missing credential, `context_mismatch`) is the transport's.

## 12. Idempotency

- **`record` is idempotent per blob key.** A repeat with a `blob` already recorded in the
  workspace answers the first call's `{ uri, file }` and makes nothing; the repeat's other
  fields are ignored. A host that lost an answer retries it safely.
- **`create` is not idempotent**: each call makes a new file.
- **`released` is acknowledged by cursor** (§6); an unacknowledged page is repeated.
- `delete` and `delete_folder` fail `file_not_found` and `folder_not_found` for what is absent.
  `delete_workspace` is idempotent.

## 13. Never in the contract

- **The medium.** No path, file handle, query, table, bucket or object key crosses the contract;
  a blob key is the store's opaque name (§7). The store's location is configuration.
- **Bodies on MCP** beyond §7's table.
- **The host's serving machinery**: routes, headers, ranges, caches.
- **Sharing.** A file is its owner's alone in 1.0. Visibility beyond the owner is a later minor,
  decided in `resolve`, never by widening the host's reads.
- **Archive, restore and retention.** A workspace's files are purged when the host says so and
  not before; any window before that is the host's.
- **Credentials and the carriage of the context**, which the host-context spec owns.

## 14. Versioning

- The version is `major.minor`. The document's URL names the major (`…/files/v1/…`).
- **The same major is compatible.** An implementation at `M.m` meets a need for `N.n` when
  `M = N` and `m >= n`. A host states the minor it needs and refuses an implementation below
  it.
- **A minor only adds**: an optional input field, an output field, a tool, an error code, a
  resource, a paged type for `read`, a value of a public output's string set (§5).
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
- **Errors are `{ code, error }`** with the closed codes of §11, not a bare `{ error }`. The
  texts keep `File not found: ` and `Folder not found: `; a taken folder name, a folder moved
  into itself and a non-empty folder are `Conflict: …`; a bad base64 body is
  `Invalid arguments for "create": …`.
- **`create`'s body is bounded** at 4 MiB decoded (`too_large`).
- **Ids are the implementation's.** A folder id is matched by the grammar of §4 instead of one
  implementation's `fd_` and 24 hex characters.
- **A record's `source` is an open string** in outputs (its four values unchanged), and the
  record no longer carries `deleted` or `deletedAt`, which a live record never had set.
- **`runId` comes from the host context** (`runId`, host-context spec §5).
- **The host's routes change with it** (not tools of this contract): the browser download route
  names the workspace (`/v1/workspaces/:workspaceId/files/:id`), because `resolve` is walled to
  the workspace in the caller's context; and an attachment's text reaches the prompt through
  `read`.

## 16. Conformance

The conformance runner speaks only MCP to an implementation and reads only this document. An
implementation is conformant when it holds every rule this file states; the runner checks at
least:

- every tool's schemas, the walls (owner and workspace), and the principal rule (each private
  tool answers a `person` with `forbidden`);
- that `create`'s body round-trips through the blob store unchanged, `too_large` past 4 MiB, and
  `invalid_input` for unpadded or base64url bodies;
- `record` idempotent per blob key, and `resolve` found for the owner and absent for another
  owner, another workspace and a deleted file;
- that a deleted file's key, and the key of a `create` that failed after its put, appear in
  `released` until acknowledged and never after;
- `read`'s bound, pages, `not_paged`, and that no public output, error or screen carries a blob
  key or a body;
- that the server answers no `resources/read` of a `files://` URI;
- that every private answer is valid against its closed schema at the stated `version`.

The document is also held by unit tests: it compiles whole as JSON Schema 2020-12, every
`$ref` resolves, every tool carries its markings, every public tool is allowed unattended and
every private one refused, the private inputs carry `version`, and no public output names a
blob key.

Generate types for another language from the document's `$defs`; never write them by hand.
