# The host context, version 1

Every contract a NimbleBrain host consumes (`contracts/<name>/CONTRACT.md`) is called with the
same authenticated context: who is calling, the scope the call is walled to, and the host's
clock when it sent the call. This file is
its normative rule. Its shape is one JSON Schema,
[`schemas/host-context/v1/host-context.schema.json`](../../schemas/host-context/v1/host-context.schema.json),
published at its `$id`. A contract says which dimensions its tools need and what it answers
when one is missing; how the context reaches a server, and when a server may believe it, is
here, once, for every contract.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## 1. Where it is and what it holds

**The context is the object at `params._meta["ai.nimblebrain/context"]` of a request.**

```json
{ "principal": "person", "workspaceId": "ws_0123456789abcdef", "ownerId": "user_1",
  "conversationId": "conv_0123456789abcdef", "now": "2026-01-01T12:00:00.000Z" }
```

| Field | Required | Meaning |
|---|---|---|
| `principal` | yes | `host`, the host's own code; or `person`, a user directly or through an agent or an app |
| `workspaceId` | no | the workspace the call is walled to |
| `ownerId` | no | the verified identity whose records the call reads and writes |
| `conversationId` | no | the conversation the call is made inside, during a chat turn |
| `runId` | no | the unattended run the call is made inside, during a run (§5) |
| `now` | no | the host's clock when it sent the request: an RFC 3339 instant in UTC, `Z` only, fractional seconds allowed (§2) |
| `grant` | no | the run grant for the call's workspace and owner, on a `person` call to a tool its contract marks `grant: true` (§6) |
| `unattended` | no | `true` when the call is made inside an unattended run, with no person present (§7) |

- **A value that fails the schema is no context.** The call then names no principal and has no
  scope, and the server answers as its contract says for that.
- **A call whose context names no principal is not `host`.** Neither is a call with no context.
- **Readers ignore fields they do not know.** Version 1 only adds optional fields (§8).

## 2. The host stamps it

- **The host stamps the context on every request it sends to a plugin server, and overwrites
  any value a caller supplied.** No tool argument and no caller's `_meta` sets it.
- **Only the host's own code presents `host`.** An agent's tool call, an MCP App's `tools/call`
  through the host's bridge, and a request at a door where MCP clients connect all present
  `person`, whatever they name.
- **Each dimension is the host's verified fact**: the workspace from the route the request came
  through, the owner from the signed-in identity, the conversation from the turn that made the
  call, the run from the run that made the call or that the host's own call is made for. A
  dimension the host cannot verify is left out, never guessed or defaulted.
- **The host stamps `now`, its clock when it sends the request, on every request.** One
  instant per request, so every decision a call makes is taken on one clock, the host's, and
  a test or a replay can state it. A plugin never falls back to its own clock for a decision a
  contract assigns to the call's `now`: a call without it fails as that contract says for a
  missing context, and a contract that reads `now` says so.
- **A decision made outside any host call uses the plugin's own clock, and its contract says
  so.** Serving a transfer URL, or a sweep the plugin runs on a timer, has no request whose
  `now` it could take; the contract names each such decision, so its clock is never a guess.

## 3. A server believes it only from the host

**A server MUST believe the context only from an authenticated host transport**, and MUST NOT
accept it from anyone else:

- **stdio**: by construction. The host started the process and alone holds its pipe, so every
  request on it is the host's.
- **HTTP**: by a credential the operator issues to the host for that server, presented on
  every request. A request without it is refused before any tool runs, and its `_meta` is
  never read.

## 4. Transport-verified dimensions win

A transport MAY verify a dimension itself, before the request reaches the server: an edge in
front of a fleet of servers authenticates the host and sets `x-tenant-id` and `x-workspace-id`,
and admits nothing else to the server.

- **A verified value wins.** Where the context omits a dimension the transport verified, the
  server uses the verified value.
- **A context that contradicts a verified dimension is refused** before any tool runs: a
  JSON-RPC error, code `-32602`, with `data.code` `"context_mismatch"`. Nothing is read or
  written.
- **`context_mismatch` is this spec's one error, outside every contract's error list.** It is a
  refusal by the transport, before any tool runs (each contract's errors leave those to the
  transport), and it means the same in every contract: the host's word and the transport's
  disagree, so neither is believed.
- **The tenant is never in the context.** One deployment's host has no tenant to state; a
  server serving several tenants learns the tenant only from its transport, and walls every
  call by that tenant in addition to the contract's own scope.

## 5. Why `conversationId` and `runId` are here

The conversation a call is made inside is a fact of the request, like its workspace: the host
knows it from the turn that made the call, and no caller can supply it. It is not a fact of
any one contract. The conversations contract reads it to resolve an omitted `id`; any other
contract MAY read it (to attribute a write to the turn that made it, or to tell that a turn is
live) and otherwise ignores it. It is optional because most calls are not made inside a chat,
and it grants nothing: a server walls by workspace and owner whether or not it is present.

`runId` is the same fact for an unattended run: the run a call is made inside, or that a
`host` call is made for, known to the host from the run, never supplied by a caller. The files contract reads it to
attribute a file to the run that wrote it; any other contract MAY read it and otherwise ignores
it. It grants nothing, and is independent of `unattended` (§7): the flag walls, the id
attributes.

## 6. Run grants

A run that no person starts (a scheduled task, a requested run picked up later) still acts
for a person. The **run grant** is the host's signed record that a person, in a workspace, set
up work under a contract that will run as them unattended.

- **A contract marks the tools that take a grant** with `"grant": true` in the tool's entry of
  its document. Only a public tool marked `unattended: "refused"` may carry it.
- **The host stamps `grant` only on a `person` call to a tool marked `grant: true`**, with a
  workspace and an owner. It never stamps one on a `host` call, on another tool, or on a call
  made inside an unattended run (those tools are refused there), so no run can obtain
  authority for another run.
- **The grant is signed by the host over its claims**: the contract's name, `workspaceId` and
  `ownerId`. Its format is the host's to choose and to change, and it is opaque to the server.
- **The server stores it verbatim and returns it verbatim.** It keeps the grant of the latest
  grant-marked call that names a definition with that definition, and gives it back when the
  host runs the definition (the contract says where). It never parses it, never shows it in a
  public output, and never hands it to another server.
- **The host decides whether it still holds.** Before admitting a run, the host verifies the
  grant's signature with its signing key, that it names the contract and the workspace of the
  call, and that its owner is a member of the workspace now; the run acts as that owner. A grant
  that fails any check admits nothing. Membership is checked at every run, so a grant needs no
  expiry. When the host's signing key changes, every grant signed with the old one fails, and
  the next grant-marked call that names the definition stores a new one.

## 7. Unattended calls

Each tool of a contract is marked `unattended: "allowed"` or `"refused"` in its document:
whether a call made inside an unattended run may reach it. A run fires as its owner with no
person present and often reads untrusted content, so a tool that would let such content
outlive the run (authoring or starting more runs) is `refused`. A private tool is always
`refused`; no run reaches one.

- **The host stamps `unattended: true` on every `person` call a run makes**, and refuses a
  `refused` tool itself before calling the server: it never offers one to the run.
- **A `host` call never carries `unattended`**, even one the host makes for a run (to take in
  or serve a run's file, to record what it wrote). It MAY carry the run's `runId` (§5), which
  attributes and grants nothing, so a private tool answers it as any `host` call.
- **A server refuses a `refused` tool on a call that carries `unattended: true`**, with the
  error its contract names, and changes nothing. The host's refusal keeps the tool out of
  view; the server's is the boundary, as for private tools.
- `unattended` grants nothing: a call without it is walled exactly as one with it.

## 8. Versioning and conformance

- The schema's URL names the major (`…/host-context/v1/…`). Version 1 only adds optional
  fields, served in place. A change to a field's meaning, a newly required field, or a new
  place for the context is a new major beside this one.
- A reader in any language is checked against the schema: every context the schema accepts it
  reads, and every value the schema refuses it reads as no context. The TypeScript reader is
  `packages/server-sdk` and the Python reader `packages/server-sdk-py`; their tests hold each
  to the schema with the same fixtures.
