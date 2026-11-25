# The conversations contract, `ai.nimblebrain.conversations` 1.0

An implementation of this contract stores a deployment's chat history and serves it to the
people and agents that read it. The **host** (the NimbleBrain runtime) persists every chat turn
through it and serves its app to the web shell, to MCP clients and to agents.

`contract.json`, this file, `errors.json` and `schemas/**/*.json` are the contract. They are
language-neutral: an implementation or a client in any language is written from the JSON. The
TypeBox sources the JSON is emitted from are where it is authored, not part of it.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 1. Identity, location, cardinality, roles

```json
{ "id": "ai.nimblebrain.conversations", "version": "1.0", "cardinality": "singleton",
  "roles": { "app": { "visibility": "public" }, "records": { "visibility": "private" } } }
```

- **`id`** is a permanent reverse-DNS name. A contract is matched by its id, never by a URL.
- **Location is derived from the id, never stated**:
  `https://schemas.nimblebrain.ai/contracts/<id>/<major>/`, so this contract is published at
  `https://schemas.nimblebrain.ai/contracts/ai.nimblebrain.conversations/1/`. Every schema's
  `$id` sits under it, with the major only (`…/1/app/list.input.json`,
  `…/1/records/append_events.input.json`, `…/1/errors.json`). The location says where the
  contract is published; it is not the contract's identity.
- **`version`** is `major.minor` (§8).
- **`cardinality`** is `singleton`: an instance has at most one enabled implementation. A host
  that finds two refuses to start.
- **`roles`** are the MCP servers an implementation provides. Each role's tools are listed by
  its schemas: `schemas/<role>/<tool>.input.json` and `.output.json`.
  - **`app`** is **public**: the tools and screen people and agents use. Any host that installs
    the implementation may expose it.
  - **`records`** is **private**: the operations the host uses to save and read what it depends
    on. Only the host reaches it, with a credential of its own; no agent, app or other host
    can.

An implementation provides every role. A role's server MAY serve more than the contract
names; a client ignores what it does not know.

## 2. Scope

**Every call is walled to one scope: one workspace and one owner.** The owner is the verified
identity whose conversations are read and written.

1. **Scope is carried by the connection's authenticated context, never by a tool argument.**
   The host mints it from the request it is serving. A value a caller types into a tool's
   arguments cannot set or widen it, and no schema in this contract has a workspace or owner
   input.
2. **Out of scope is indistinguishable from absent.** A conversation in another workspace, or
   another owner's, answers exactly as one that does not exist: `get` answers `null` (records)
   or `conversation_not_found` (app), `events` an empty page, `list` and `search` leave it
   out, `delete` answers `false`, `append_events` fails `conversation_not_found`. No answer
   reveals that another scope's conversation exists.
3. **A call with no scope reads and writes nothing.** A records call that reaches a server with
   no workspace or no owner fails `scope_missing`; an app call fails with the app's
   `scope_missing` error. A transport MAY refuse such a request before any tool runs; that
   refusal is the transport's and outside `errors.json`.
4. **`delete_workspace` is the one call that crosses owners**: it removes every owner's
   conversations in the scope's workspace and ignores the scope's owner.
5. **An app call MAY carry the conversation it is made inside.** Inside a chat, the host's
   context names the current conversation; an omitted `id` (or `"current"`) on `get`,
   `update` and `export` means that one. Outside a chat there is none, and the call fails
   `no_current_conversation`.

**How the scope reaches a server is transport-specific and non-normative.** A host and an
implementation agree on it per transport: an authenticated URL and credential (a host's
`/mcp/<wsId>`, where the workspace is in the URL and the owner is the signed-in identity),
request metadata on a connection the host alone holds (`params._meta["ai.nimblebrain/scope"]`
on a process the host started), or headers behind an authenticating proxy. Each carries the
same scope with the same rules; none is part of the contract.

## 3. The records role

Tools: `create`, `get`, `events`, `append_events`, `update`, `delete`, `delete_workspace`,
`list`, `search`. A success carries its payload in `structuredContent`, valid against the
tool's output schema. A failure is `isError: true` whose first text content is JSON
`{ "code", "error" }`, `code` from `errors.json#/records`.

**Events.** An event is an object with a string `ts` and a string `type`, plus the fields its
type defines. An implementation stores events opaquely and returns each one as written, except
that it MAY reorder object keys. It refuses a batch that is not a list of such objects
(`invalid_input`) and writes nothing.

**Ordering.**

1. The implementation assigns `seq`: per conversation, starting at 1, increasing by 1, with no
   gaps. Order never comes from a caller's clock or lock.
2. `append_events` is all or none and returns the last event's `seq`. An empty batch writes
   nothing and returns the current last `seq` (0 when there is none).
3. Concurrent appends to one conversation are serialized; two batches never interleave.
4. `events` returns events in `seq` order after `afterSeq` (default 0), at most `limit`
   (default 1000, maximum 5000), and none after `throughSeq` when it is given. Every page
   reports the conversation's last `seq` as `lastSeq`; a reader that wants a snapshot passes
   the first page's `lastSeq` as `throughSeq` on later pages.
5. `list` orders newest first, by last activity (`sort: "updated"`, the default) or by creation
   (`"created"`), ties broken by id. `lastActivityAt` is the last event's `ts`.

**Cursors.** `list` and `search` page by `nextCursor`, `null` on the last page. A cursor is
opaque: a client passes it back unchanged and never builds or parses one. A cursor is stable
under inserts: following it from a page never repeats a conversation already returned and never
skips one that existed when the first page was read. A conversation created after the first page
MAY be absent from later pages.

**Projections.** `get`, `update` and `list` answer a conversation with its title (the last
`metadata.title` event), last model and last activity, projected from its events. A summary's
`messageCount` counts user messages plus completed runs; `usage` is token counts per model.
Cost is never stored or returned; the host prices it.

**Writes.** `create` refuses an `id` already stored in scope (`conversation_exists`) and a
workspace the implementation holds nothing for (`workspace_not_found`), so a late write never
brings back a deleted workspace. `update` records a new title as a `metadata.title` event.
`delete` answers whether it removed something. `delete_workspace` is idempotent and answers
what it removed.

## 4. The app role

Tools: `list`, `get`, `search`, `update`, `stats`, `export`. Every tool except `update` is
annotated `readOnlyHint: true`. A success carries the result in `structuredContent`, valid
against the tool's output schema, and a human- and model-readable rendering in `content`. A
failure is `isError: true` whose first text content is JSON `{ "error" }`, the message
beginning with the `prefix` of an entry in `errors.json#/app`.

A host MAY expose the app's tools under its own names (a host that serves many apps on one
connection lists them as `conversations__<tool>`); the tools, schemas and behaviour are
unchanged.

**Resource.** `ui://conversations/browser`, MIME type `text/html;profile=mcp-app` (an MCP App),
listed by `resources/list` and returned by `resources/read`. Reading any other URI is a
JSON-RPC error.

- `list` rows carry `active`, whether a reply is generating now. An implementation that cannot
  know reports `false`, and the host overlays the true value.
- `list` pages by an opaque `nextCursor`, under the cursor rules of §3.
- `update` records the title as a `metadata.title` event, as `records.update` does.
- Outputs are open: a client ignores fields it does not know.

## 5. Errors

`errors.json` is the closed list.

- **Records**: `isError: true`, text JSON `{ code, error }`. `code` is one of
  `invalid_input`, `unknown_tool`, `scope_missing`, `conversation_not_found`,
  `conversation_exists`, `workspace_not_found`, `conversation_corrupted`, `internal_error`.
  `error` is diagnostic only.
- **App**: `isError: true`, text JSON `{ error }`. The message begins with the prefix of one
  of `conversation_not_found`, `no_current_conversation`, `scope_missing`, `invalid_input`,
  `unknown_tool`. The app carries no `code` on the wire in 1.0: its error shape is the one
  models already read.
- A failed call writes nothing.
- Refusals before any tool runs (a missing or invalid credential, a request the transport
  cannot place in a scope) belong to the transport.

## 6. Idempotency

**Idempotency keys are absent in 1.0.** No call carries one. A host that retries an
`append_events` whose answer it did not receive may append the batch twice, so a host does not
retry an append blindly. `create` with an explicit `id` is the one naturally idempotent write:
a repeat fails `conversation_exists`. `delete` and `delete_workspace` are idempotent by their
answers (`false`, an empty list).

## 7. Never in the contract

- **The medium.** No path, file handle, offset, query, table, or bucket or object key crosses
  the contract, as an input, an output or an error. How and where an implementation stores
  conversations is its own property.
- **Tenancy above the workspace.** An implementation serves one deployment.
- **Run liveness, model choice, cost, compaction**, and how the host builds what it sends a
  model.
- **The screen's internals.** The contract names the resource and its MIME type, not its HTML.
- **The auth credential and the scope's transport carriage** (§2).

## 8. Versioning

- The version is `major.minor`, in `contract.json` and in each implementation's declaration of
  what it implements. Schema `$id`s carry the major only.
- **The same major is compatible.** An implementation at `M.m` meets a need for `N.n` when
  `M = N` and `m >= n`. A host states the minor it needs and refuses an implementation below
  it; it ignores what a higher minor adds.
- **A minor only adds**: an optional input field, an output field (outputs are open), a tool, an
  error code or app error kind, a resource.
- **Anything else is a new major**: a removed or renamed tool or field, a narrowed input, a
  newly required input, a changed meaning. A new major is published at its own location
  (`…/<id>/2/`) beside the old one.

## 9. Conformance

`runner/conformance.ts` checks an implementation black-box. It speaks only MCP to the URLs it
is given and reads only this directory's JSON. Each role's cases run only when that role's URL
is given:

```bash
bun --no-env-file contracts/conversations/runner/conformance.ts \
  --app <url> [--records <url>] [--scope-carriage none|headers|meta --workspace <id> --owner <id>] \
  [--header k=v] [--bearer-env VAR] [--tool-prefix conversations__] [--fixture <convId>]
```

`--header`, `--bearer-env`, `--scope-carriage`, `--workspace`, `--owner` and
`--protocol-version` say how the runner reaches an implementation; they are transport options,
not contract. Run with no arguments for the full option list in the file's header. An
implementation is conformant when the runner reports no failure for every role it provides.

Generate types for another language from `schemas/` (draft 2020-12, self-contained, no `$ref`);
never write them by hand.
