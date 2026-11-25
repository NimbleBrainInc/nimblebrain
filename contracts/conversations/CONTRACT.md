# The conversations contract, `ai.nimblebrain.conversations` 1.0

An implementation of this contract stores a deployment's chat history and serves it to the
people and agents that read it. The **host** (the NimbleBrain runtime) persists every chat turn
through it and serves its tools and screen to the web shell, to MCP clients and to agents.

The contract is two things: this file, and one JSON document,
[`schemas/contracts/conversations/v1/contract.json`](../../schemas/contracts/conversations/v1/contract.json),
published at its `$id`. The document holds the identity, version, cardinality, every tool with
its visibility and its input and output schema, and the closed list of errors. It is
language-neutral: an implementation or a client in any language is written from it. The
TypeBox sources it is emitted from (`source/`) are where it is authored, not part of it.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 1. Identity, location, cardinality, tools

```json
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.nimblebrain.ai/contracts/conversations/v1/contract.json",
  "id": "ai.nimblebrain.conversations", "version": "1.0", "cardinality": "singleton",
  "tools": { "list": { "visibility": "public",
                       "input": { "$ref": "#/$defs/list_input" },
                       "output": { "$ref": "#/$defs/list_output" } }, "…": {} },
  "errors": { "public": ["…"], "private": ["…"] },
  "$defs": { "list_input": {}, "list_output": {}, "…": {} } }
```

- **`id`** is the contract's identity: a permanent reverse-DNS name. A contract is matched by
  its id, never by a URL.
- **`$id` is where the document lives.** It is stated in the document, never derived from the
  id. Under NimbleBrain's domain a contract is served at
  `https://schemas.nimblebrain.ai/contracts/<short-name>/v<major>/contract.json`; a third
  party's contract lives on its own domain in the same shape.
- **`version`** is `major.minor` (§9).
- **`cardinality`** is `singleton`: an instance has at most one enabled implementation. A host
  that finds two refuses to start.
- **An implementation is one MCP server.** It serves every tool the document names, each
  with the input and output schema its `$ref` names in `$defs` (`<tool>_input`,
  `<tool>_output`), and the screen (§5). A server lists the definition itself as the tool's
  `inputSchema` and `outputSchema`, not the `$ref`. It MAY serve more than the contract names; a client ignores what it does not
  know.
- **Each tool is `public` or `private`** (§3):

| Tool | Visibility | Operation |
|---|---|---|
| `list` | public | One page of the caller's conversations, newest first |
| `get` | public | One conversation: its metadata and, by `expand`, its messages |
| `search` | public | The caller's conversations whose messages contain a text |
| `update` | public | Retitle a conversation |
| `stats` | public | Token usage over a period |
| `export` | public | A conversation as Markdown or JSON |
| `create` | private | Create a conversation |
| `events` | private | One page of a conversation's stored events, in order |
| `append_events` | private | Append events to a conversation |
| `delete` | private | Delete a conversation |
| `delete_workspace` | private | Delete every owner's conversations in a workspace |

## 2. Scope and principal

**Every call carries an authenticated context: a scope and a principal.** The host mints it
from the request it is serving. A value a caller types into a tool's arguments cannot set or
change it, and no schema in this contract has a workspace, owner or principal input.

**Scope** walls every call to one workspace and one owner. The owner is the verified identity
whose conversations are read and written.

1. **Out of scope is indistinguishable from absent.** A conversation in another workspace, or
   another owner's, answers exactly as one that does not exist: `get`, `update` and `export`
   fail `conversation_not_found`, `events` answers an empty page, `list` and `search` leave it
   out, `delete` answers `false`, `append_events` fails `conversation_not_found`. No answer
   reveals that another scope's conversation exists.
2. **A call with no scope reads and writes nothing.** A call that reaches the server with no
   workspace or no owner fails `scope_missing`. A transport MAY refuse such a request before
   any tool runs; that refusal is the transport's and outside the contract's errors.
3. **`delete_workspace` is the one call that crosses owners**: it removes every owner's
   conversations in the scope's workspace and ignores the scope's owner.
4. **A call MAY carry the conversation it is made inside.** Inside a chat, the context names
   the current conversation; an omitted `id` (or `"current"`) on `get`, `update` and `export`
   means that one. Outside a chat there is none, and the call fails
   `no_current_conversation`.

**The principal** says who is calling:

- **`host`**: the runtime itself, saving and reading the history it depends on.
- **`person`**: a user, directly or through an agent acting for them.

A call that names no principal is not `host`.

## 3. Public and private tools

**Public tools accept either principal. Private tools accept only `host`. A private tool called
by any other principal fails `forbidden`, and nothing is read or written.** The server enforces
this on every call; it is the boundary that keeps people and agents from rewriting what the
host records. The principal is checked before the input and the scope, so a `forbidden`
answer reveals nothing about either.

- **The host sets the principal on every call and discards any a caller supplied.** Only
  the host's own code presents `host`. A call that starts with anyone else (an agent's tool
  call, an MCP App's `tools/call` through the host's bridge, a request at a door where MCP
  clients connect) presents `person`, whatever it names and whatever `_meta` it carries.
- **A host never offers private tools to agents and never lists them where agents or MCP
  clients connect.** That keeps them out of view; the server's refusal is what makes them
  unreachable.
- **On a transport other parties can reach, `host` requires the host's own credential.** A
  server MUST NOT accept a caller's claim to be `host` without it.

**How scope and principal reach a server is transport-specific and non-normative.** A host
and an implementation agree on it per transport: a process the host started and alone holds
(`params._meta["ai.nimblebrain/scope"]` on each request), an authenticated URL and
credential (a host's `/mcp/<wsId>`, where the workspace is in the URL, the owner is the
signed-in identity and the principal is `person`), or headers behind an authenticating
proxy, with the host's service credential for `host`. Each carries the same context under
the same rules; none is part of the contract.

## 4. Records and ordering

**Events.** An event is an object with a string `ts` and a string `type`, plus the fields its
type defines. An implementation stores events opaquely and `events` returns each one as
written, except that it MAY reorder object keys. `append_events` refuses a batch that is not a
list of such objects (`invalid_input`) and writes nothing.

1. The implementation assigns `seq`: per conversation, starting at 1, increasing by 1, with no
   gaps. Order never comes from a caller's clock or lock.
2. `append_events` is all or none and returns the last event's `seq`. An empty batch writes
   nothing and returns the current last `seq` (0 when there is none).
3. Concurrent appends to one conversation are serialized; two batches never interleave.
4. `events` returns events in `seq` order after `afterSeq` (default 0), at most `limit`
   (default 1000, maximum 5000), and none after `throughSeq` when it is given. Every page
   reports the conversation's last `seq` as `lastSeq`; a reader that wants a snapshot passes
   the first page's `lastSeq` as `throughSeq` on later pages.
5. `list` orders newest first, by last activity (`sortBy: "updated"`, the default) or by
   creation (`"created"`), ties broken by id.

**Cursors.** `list` pages by `nextCursor`, `null` on the last page. A cursor is opaque: a
client passes it back unchanged and never builds or parses one. A cursor is stable under
inserts: following it from a page never repeats a conversation already returned and never
skips one that existed when the first page was read. A conversation created after the first
page MAY appear on later pages or be absent.

**Projections.** `get`, `update` and `list` answer a conversation with its title (the last
`metadata.title` event), last model and last activity, projected from its events. A row's
`messageCount` counts user messages plus completed runs. Cost is never stored or returned; the
host prices it.

**Writes.** `create` refuses an `id` already stored in scope (`conversation_exists`) and a
workspace the implementation holds nothing for (`workspace_not_found`), so a late write never
brings back a deleted workspace. `update` records the new title as a `metadata.title` event.
`delete` answers whether it removed something. `delete_workspace` is idempotent and answers
what it removed.

## 5. Results and the screen

A success carries its payload in `structuredContent`, valid against the tool's output schema.
A public tool also carries a human- and model-readable rendering in `content`. Every public
tool except `update` is annotated `readOnlyHint: true`. Outputs are open: a client ignores
fields it does not know.

- `list` rows carry `active`, whether a reply is generating now. An implementation that cannot
  know reports `false`, and the host overlays the true value.
- A host MAY expose the public tools under its own names (a host that serves many servers on
  one connection lists them as `conversations__<tool>`); the tools, schemas and behaviour are
  unchanged.

**Resource.** `ui://conversations/browser`, MIME type `text/html;profile=mcp-app` (an MCP App),
listed by `resources/list` and returned by `resources/read`. Reading any other URI is a
JSON-RPC error.

## 6. Errors

The document's `errors` is the closed list. A failed call writes nothing.

- **Private tools**: `isError: true`, text JSON `{ code, error }`. `code` is one of
  `forbidden`, `invalid_input`, `scope_missing`, `conversation_not_found`,
  `conversation_exists`, `workspace_not_found`, `conversation_corrupted`, `internal_error`.
  `error` is diagnostic only.
- **Public tools, and a tool name the server does not have**: `isError: true`, text JSON
  `{ code, error }`. `code` is one of `conversation_not_found`, `no_current_conversation`,
  `scope_missing`, `invalid_input`, `unknown_tool`, and `error` begins with that code's
  prefix in `errors.public`, the text models already read. A caller decides on `code`, never
  on the text.
- Refusals before any tool runs (a missing or invalid credential, a request the transport
  cannot place in a scope) belong to the transport.

## 7. Idempotency

**Idempotency keys are absent in 1.0.** No call carries one. A host that retries an
`append_events` whose answer it did not receive may append the batch twice, so a host does not
retry an append blindly. `create` with an explicit `id` is the one naturally idempotent write:
a repeat fails `conversation_exists`. `delete` and `delete_workspace` are idempotent by their
answers (`false`, an empty list).

## 8. Never in the contract

- **The medium.** No path, file handle, offset, query, table, or bucket or object key crosses
  the contract, as an input, an output or an error. How and where an implementation stores
  conversations is its own property.
- **Tenancy above the workspace.** An implementation serves one deployment.
- **Run liveness, model choice, cost, compaction**, and how the host builds what it sends a
  model.
- **The screen's internals.** The contract names the resource and its MIME type, not its HTML.
- **Credentials and the carriage of scope and principal** (§3).

## 9. Versioning

- The version is `major.minor`, in the document and in each implementation's declaration of
  what it implements. The document's URL names the major only (`…/v1/contract.json`).
- **The same major is compatible.** An implementation at `M.m` meets a need for `N.n` when
  `M = N` and `m >= n`. A host states the minor it needs and refuses an implementation below
  it; it ignores what a higher minor adds.
- **A minor only adds**: an optional input field, an output field (outputs are open), a tool, an
  error code or public error kind, a resource. A minor is served in place, at the same URL.
- **Anything else is a new major**: a removed or renamed tool or field, a narrowed input, a
  newly required input, a changed meaning, a tool changing visibility. A new major is
  a new document at its own URL (`…/conversations/v2/contract.json`) beside the old one.

## 10. Conformance

`runner/conformance.ts` checks an implementation black-box. It speaks only MCP to the URL it is
given and reads only the contract document.

```bash
bun --no-env-file contracts/conversations/runner/conformance.ts \
  --server <url> [--public-only] \
  [--carriage none|headers|meta --workspace <id> --owner <id>] \
  [--header k=v] [--bearer-env VAR] [--tool-prefix conversations__] [--fixture <convId>]
```

- **The whole contract**: `--server <url>` with `--carriage headers` or `meta`, so the runner
  can state several scopes and both principals. It checks every tool, the screen, the walls,
  and that each private tool answers a `person` with `forbidden` and changes nothing. An
  implementation is conformant when this run reports no failure.
- **A host's agent-facing surface**: `--public-only` checks only the public tools, as a
  `person`, and that no private tool is listed there or answers a call. This is how a host's
  MCP door (`/mcp/<wsId>`) is checked. With no private tools to seed one, the data cases need
  `--fixture`.

`--header`, `--bearer-env`, `--carriage`, `--workspace`, `--owner`, `--tool-prefix` and
`--protocol-version` say how the runner reaches an implementation; they are transport
options, not contract. Run with no arguments for the full option list in the file's header.

Generate types for another language from the document's `$defs` (draft 2020-12; each entry is
self-contained, with no `$ref` of its own); never write them by hand.
