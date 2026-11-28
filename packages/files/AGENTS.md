# Files plugin

Scope: `packages/files/`. An implementation of the files contract
(`contracts/files/CONTRACT.md`, `ai.nimblebrain.files` 1.0): an Agent Plugin with one MCP
server, on the local filesystem, its transfer listener, its screen and its skill. The runtime
binds it by default (`plugins: { files: false }` turns files off); the kernel's side of the
contract is `src/files/AGENTS.md`.
How to run it standalone is in `README.md`.

## Boundaries

- **Never import the kernel.** This package imports only `packages/server-sdk` and reads the
  contract document (`schemas/contracts/files/v1/contract.json`). The screen (`ui/`) is its own
  package. Biome refuses any other import that leaves the package.
- **The contract document is the interface.** `tools/list` serves each tool's schemas and each
  public tool's annotations from the document unchanged, inputs are validated against them
  (formats asserted), and visibility comes from it. Private answers are checked against their
  closed schemas before they leave (`server.ts`). Changing a tool's shape is a contract change.
- **The type rules are `src/mime.ts`**: the recorded type, the extension table, the allowlist
  and each type's kind. `test/unit/contracts/contract-documents.test.ts` holds them to the
  tables in `CONTRACT.md` §5 and §7; change a table there first.
- **`plugin.json` and `mcp.json` follow Agent Plugins 1.0.0**; NimbleBrain's declaration is only
  `extensions["ai.nimblebrain"].implements`. The host passes the data directory
  (`--data-dir ${PLUGIN_DATA}`).
- **The guide is `skills/files/SKILL.md`**, in the format's skills layout. A host that loads a
  plugin's skills reads it (bound to `files__*`), and the server serves its body, without the
  frontmatter, as its `instructions`. A change to how the tools are used is a change to that
  file.

## Calls

- **The context is the host context**, read by `packages/server-sdk`, believed only from an
  authenticated host transport (`src/main.ts`): stdio by construction; HTTP by
  `Authorization: Bearer $NB_FILES_TOKEN` (at least 32 characters, `host` on every tool, so
  HTTP listens on loopback and warns otherwise). It reads `principal`, `workspaceId`,
  `ownerId`, `conversationId` and `runId`.
- **Every `tools/call` is decided in one order** (`src/server.ts`): `unknown_tool`, `forbidden`
  (private tool, principal not `host`), `invalid_input`, `scope_missing` (`delete_workspace`
  needs a workspace; every other tool a workspace and an owner), then the tool. No public tool
  is refused unattended.
- **Walls**: every record carries its owner, and each workspace is its own directory. A file,
  folder or upload of another owner or workspace answers exactly as an absent one.
- **Provenance comes from the context**: `create` and `begin_upload` record the context's
  `conversationId` and `runId`; no argument sets either.
- **An answer about one file names it** (`create`, `info`, `read`): `content` carries a
  `resource_link` to `files://<id>` with the filename, recorded type and size (`fileLink` in
  `src/server.ts`), beside the readable text; `structuredContent` is the contract's payload
  alone. The chat renders the link with a Download button, which is how the skill hands a
  person a file.
- **Errors are `{ code, error }`**; a public error's text is its prefix then the id or detail.
  An unexpected failure answers `internal_error` (private) or a JSON-RPC internal error
  (public) with a fixed message; its detail goes only to stderr.

## Storage (`src/store.ts`)

- **Layout:** `<data>/workspaces/<workspaceId>/state.json` (every owner's file and folder
  records, and each upload completed within its completion window), `bodies/<fileId>` (a
  file's body, written once), `uploads/<uploadId>` (the body last PUT to an open upload).
- **An open upload lives in memory only**, like its URL: a restart kills both, so a record of
  it on disk would buy nothing. `begin_upload` writes nothing; `complete_upload` is the
  upload's one commit. `state.json` is rewritten whole on every commit, so a write per
  `begin_upload` makes a run of uploads cost the square of a workspace's records.
- **A completed upload keeps its file's id, its URL's `expiresAt`, and the fields a later call
  can change (`tags`, `folderId`) as they were.** A repeat rebuilds the first record from the
  file's row and those; a tool that comes to change another field of a row adds it there.
- **`state.json` is the only commit point.** A call changes the workspace in memory; the
  bodies it adds are made durable under `bodies/` first (each fsynced, then the directory),
  then `state.json` is replaced atomically (fsynced, renamed, the workspace directory
  fsynced), and only then are the bodies it removes unlinked. A new directory is fsynced into
  its parent. A workspace's first load in a process removes what no committed record names
  (a body written before a commit that never landed, one left by a delete whose unlink never
  ran, every upload's body, temporary files), so storage holds what the state says. A
  call that throws evicts the workspace from memory; the reload rereads the state and removes
  nothing, since a PUT may be streaming to a temporary file.
- **No body is visible partly written.** `create` writes beside the final name, fsyncs and
  renames. A PUT streams to a temporary file, fsyncs it and renames it over the upload's
  body, so a repeated PUT replaces the earlier one whole. `complete_upload` hard-links the
  upload's body into `bodies/`, commits, then unlinks the upload's name.
- **One process owns a data directory.** State I/O is synchronous, so one process's calls
  never interleave; two processes on one directory are not serialized. The workspace id is
  the only path segment taken from a call; every other name is minted here.

## Transfers (`src/transfer.ts`)

- **A transfer URL is `<origin>/t/<id>.<secret>`**: a 128-bit id finds the grant and a 256-bit
  secret is compared in constant time as the text issued, never decoded: base64 decoding
  ignores unused low bits and padding, so another spelling would pass. Grants live in memory: a restart kills every URL and
  every open upload, and a host begins again or resolves again.
- **The listener**: over stdio, its own `Bun.serve` bound to `127.0.0.1` on a port the OS
  picks, started before the server answers; over HTTP, the server's own origin under `/t/`
  (`--transfer-origin` names another). It answers a GET of a live download grant (200, or
  206 with `Content-Range` for one `bytes=` range; 416 for an unsatisfiable one; 200 whole for several ranges or one it cannot parse) and a PUT of
  a live upload grant (204), and 404 with an empty body to everything else. It sends no CORS
  headers and logs nothing, so a token never reaches a log.
- **Lifetimes**: a download URL lives `--download-ttl` (default and most 300 s), an upload URL
  `--upload-ttl` (default and most 900 s). A request is judged live when it begins. An upload
  URL dies when its upload completes. A PUT longer than the declared size is refused (413) and
  stores nothing.
- **Completion**: `complete_upload` measures the stored body; absent or another length is
  `upload_incomplete` and the upload stays open. It succeeds up to 300 s past `expiresAt`
  (`COMPLETION_GRACE_MS`), and a repeat answers the first `{ uri, file }` (rebuilt from what the
  completed upload keeps, so tags or a move since do not change it) while that file exists, in
  that same window. Past the window an upload is retired, an open one with its bytes, on the
  next call into its workspace and every minute for each workspace that is loaded or has an
  open upload. Retiring commits nothing: a retired completed upload leaves `state.json` with
  the next commit.
- **A download GET re-checks the record**: a file deleted since its URL was issued is 404.
- **The per-file limit** for `begin_upload` is `--max-file-bytes`, else `NB_FILES_MAX_FILE_BYTES`,
  else 25 MiB. The variable is a launch convention, not part of the contract: the runtime's
  files binding sets it to the operator's `files.maxFileSize` when it starts the server, so the
  host's intake and `begin_upload` refuse at one size.

## Extraction (`src/extract.ts`)

Text is extracted in this process (CONTRACT.md §8): every `text/*` type, JSON, XML and YAML
as UTF-8; PDF by page (unpdf); DOCX as Markdown (mammoth); XLSX's first sheet as CSV
(SheetJS, pinned exact: advisories are keyed to its republished name). The bound on the text
kept is 1 MiB (`TEXT_BOUND`), and `read` cuts it to `maxBytes` at a character boundary. Work is
bounded before parsing: a DOCX or XLSX whose central directory declares more XML than its
parser's budget, more than 64 MiB in all, ZIP64 or a malformed directory is refused unread; a
PDF stops at the page its text passes the bound, at 2,000 pages, or after 5 s. One extraction
runs at a time. A refused or failed extraction is a body with no text (`extractedText: null`,
or `extraction_failed` for `pages`). Nothing is cached: each `read` extracts again.
The parsers (unpdf, mammoth, SheetJS) are imported on first use, never at module load: they
are most of the server's start time, and every boot starts it (`test/integration/bound-servers-start.test.ts`).

## The screen

`ui://files/browser` (`text/html;profile=mcp-app`) serves the built `ui/dist/index.html`
(`--screen` names another), a placeholder page when it is not built. It reads bodies through
the host's `resources/read` of `files://`; the server advertises the `files://{id}` template
and answers no `resources/read` of a `files://` URI itself. `list` pages by cursor, so the
screen keeps each page's opening cursor and walks forward to a page it has not reached
(`ui/src/useFileList.ts`). `ui/` is its own package, installed, built, tested and
typechecked with the platform app UIs, and built in the image. The handshake carries
`_meta["ai.nimblebrain/host"]` with the sidebar placement (`HOST_META`), through the server
SDK's `declareHostMeta`.

## Tests

- `test/integration/files-plugin-conformance.test.ts` runs the contract's runner
  (`contracts/files/runner/conformance.ts`) against `bin/nb-files` over stdio and over HTTP
  (every case passes but the one that waits 300 s past an upload's expiry, which the runner
  skips unless given `--wait-grace`) and in public-only mode (only `no private tool is listed`
  fails, which holds a host's door), and checks the credential, the addresses and the
  handshake placement.
- `test/unit/plugins/files-plugin.test.ts`: the store's commit point and recovery, the upload
  windows on a set clock, the transfer handler's grammar, DOCX and XLSX extraction and its
  budgets, internal failures.
- `test/unit/contracts/contract-documents.test.ts` holds `src/mime.ts` to the contract's
  tables.
