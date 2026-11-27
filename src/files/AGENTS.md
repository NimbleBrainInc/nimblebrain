# Files

Scope: the kernel's side of the files contract (`src/files/`, and the doors in
`src/api/file-doors.ts` and `src/api/file-serve.ts`). The contract is
`contracts/files/CONTRACT.md`; its §7 (bytes) and §10 (the host's obligations) are what this
code implements. The built-in implementation is `packages/files/` (`packages/files/AGENTS.md`).

## The plugin owns files; the kernel owns the doors

- **The kernel holds no file, record or byte.** It reaches the server bound to
  `ai.nimblebrain.files` through `runtime.getFiles()` (`host.ts`): `begin_upload`,
  `complete_upload`, `resolve`, `read`, `list` and `delete` as `host`, walled to a workspace and
  an owner. Agents, the door and the bridge reach the public `files__*` tools through the bound
  source, as `person`. Never add a kernel store, cache or index of files.
- **Files are off while nothing implements the contract** (`plugins: { files: false }`).
  `getFiles()` is null: no `files__` tools, attachments and uploads refused, every file route
  answers `404 files_disabled`, host-resources advertises no scheme, the bootstrap carries no
  attachment limits. Check `getFiles()` at the door, never a feature flag.
- **A `files://<id>` URI is bare.** The workspace comes from the request's door (the path's
  workspace, the run's, the connector's), the owner from its identity. Every door names its
  workspace; none locates a file without one. `FILE_ID_RE` (`uri.ts`) is the contract's id
  grammar.

## One intake (`intake.ts`)

- **Every door takes files in through it**: a chat turn's attachments, the REST upload
  (`POST /v1/workspaces/:wsId/resources`), which the app bridge's uploads use too.
- **The per-file limit is one value**: `files.maxFileSize` is passed to the bound server as
  `NB_FILES_MAX_FILE_BYTES` (`filesServerEnv`, `contract.ts`) when it starts, so the intake and
  `begin_upload` never disagree. Never give the plugin a limit of its own in `mcp.json`.
- **Check before opening any upload**: count, each size, the total, the allowlist
  (`mime.ts`, held to the contract document by `test/unit/contracts/contract-documents.test.ts`).
  A part with no type is sent as `application/octet-stream`; the plugin records a text type
  from the extension.
- **Then begin, stream, complete.** `begin_upload` as `host` walled to the workspace and the
  uploader, with the turn's `conversationId` in the scope; the body streamed to the upload URL;
  `complete_upload`. A chat turn with no conversation yet mints its id first
  (`ChatRequest.newConversationId`), so every record names it. The REST door is per file; a
  chat turn is all or none, deleting (as `host`) what it completed when a later step fails.
- **Never hold a body in memory.** A multipart request is read as it arrives
  (`multipart.ts`): each file part is spooled to `<workDir>/tmp/intake/` and measured, since
  `begin_upload` needs the exact size and every check precedes every upload. The spool is
  removed when the request ends, whatever the outcome.
- **Announce the kernel's writes** (`runtime.announceFilesChange`), as the plugin's own tools
  are announced, so the owner's Files screen refreshes.

## Transfers (`transfer.ts`)

- **Every transfer goes through the SSRF-guarded fetch with redirects refused**, to a
  destination the binding authorises (`BoundServer.transferDestinations`): its own server's
  origin, the plugin's `transferOrigins` (`nimblebrain.json`), and literal loopback for a stdio
  binding. A name is resolved once; one that resolves to a loopback, link-local, unspecified
  or multicast address is refused, and the request connects to the address checked. That is
  the transfer's whole policy: it is the guarded fetch's `authorize`, in place of
  `validateConnectorUrl`, so a listed origin is reached at its scheme even on a private address.
- **Check before a byte is used**: a GET succeeds only on 200, or 206 when the host sent a
  `Range` (with the `Content-Range` it asked for); no `Content-Encoding` but `identity`; a
  `Content-Length` equal to the record's (or the range's). Bodies are counted while they stream
  and fail on an overrun or a short end. A PUT succeeds on any 2xx, sends its own
  `Content-Length`, and refuses upload headers the host owns.
- **A transfer URL is a bearer capability.** It never reaches a log, an error, an agent, an
  app or a browser: a failure is a `TransferError` naming what went wrong, never where.

## Serving

- **Every door serves through `resolve`** as `host` with the caller's own workspace and owner;
  absent and another owner's file answer alike.
  - The browser download, `GET /v1/workspaces/:wsId/files/:fileId` (`file-serve.ts`): the
    host's own headers (the record's `Content-Type`, parameters kept, when its bare type is
    allowlisted and it is tokens throughout, else octet-stream; `nosniff`,
    `FILE_BYTES_CSP`, a sanitised RFC 6266 `Content-Disposition`), one `Range` passed through.
    `FILE_BYTES_CSP` is always sent: an operator can clear `NB_CSP`, and a stored HTML or SVG
    file must never run script on the shell's origin.
  - `resources/read` of `files://` at the MCP door (scoped to a source or not), the REST read
    and so the bridge: the host answers it whichever source the read names; the plugin never
    does. The door's `resources/list` adds the caller's files from `list`. The chat's
    rendering of a tool's `resource_link` (`web/src/components/ResourceLinkView.tsx`, the
    document panel) reads through the REST read and downloads the bytes it got.
  - A run's prompt (`rehydrate.ts`): one batched `resolve` per run; images and a PDF the model
    takes are streamed in; a PDF it does not take is read as text through `read`.
  - A connector's host-resources read and list (`src/host-resources/resolver.ts`): `list`
    followed to its last cursor, the type filter exact.
- **The model's view of an attachment comes from `read`**, with `maxExtractedTextSize` (at
  most the contract's 1 MiB) as `maxBytes`. The kernel runs no parser.

## Runs and purges

- **`filesWritten` is the host's own record**: the bound source's result overlay sees each
  successful `files__create` made inside a run (`RequestContext.runId`) and records its URI and
  filename; the run's result takes them. No other tool's output is read for files.
- **A deleted workspace takes no files call** at any door: the files binding's call guard
  refuses every call but `delete_workspace` while the workspace is tombstoned. The purge calls
  `delete_workspace` like every other binding's (`src/workspace/AGENTS.md`).
