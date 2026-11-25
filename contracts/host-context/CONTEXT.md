# The host context, version 1

Every contract a NimbleBrain host consumes (`contracts/<name>/CONTRACT.md`) is called with the
same authenticated context: who is calling, and the scope the call is walled to. This file is
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
  "conversationId": "conv_0123456789abcdef" }
```

| Field | Required | Meaning |
|---|---|---|
| `principal` | yes | `host`, the host's own code; or `person`, a user directly or through an agent or an app |
| `workspaceId` | no | the workspace the call is walled to |
| `ownerId` | no | the verified identity whose records the call reads and writes |
| `conversationId` | no | the conversation the call is made inside, during a chat turn |

- **A value that fails the schema is no context.** The call then names no principal and has no
  scope, and the server answers as its contract says for that.
- **A call whose context names no principal is not `host`.** Neither is a call with no context.
- **Readers ignore fields they do not know.** Version 1 only adds optional fields (§6).

## 2. The host stamps it

- **The host stamps the context on every request it sends to a plugin server, and overwrites
  any value a caller supplied.** No tool argument and no caller's `_meta` sets it.
- **Only the host's own code presents `host`.** An agent's tool call, an MCP App's `tools/call`
  through the host's bridge, and a request at a door where MCP clients connect all present
  `person`, whatever they name.
- **Each dimension is the host's verified fact**: the workspace from the route the request came
  through, the owner from the signed-in identity, the conversation from the turn that made the
  call. A dimension the host cannot verify is left out, never guessed or defaulted.

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

## 5. Why `conversationId` is here

The conversation a call is made inside is a fact of the request, like its workspace: the host
knows it from the turn that made the call, and no caller can supply it. It is not a fact of
any one contract. The conversations contract reads it to resolve an omitted `id`; any other
contract MAY read it (to attribute a write to the turn that made it, or to tell that a turn is
live) and otherwise ignores it. It is optional because most calls are not made inside a chat,
and it grants nothing: a server walls by workspace and owner whether or not it is present.

## 6. Versioning and conformance

- The schema's URL names the major (`…/host-context/v1/…`). Version 1 only adds optional
  fields, served in place. A change to a field's meaning, a newly required field, or a new
  place for the context is a new major beside this one.
- A reader in any language is checked against the schema: every context the schema accepts it
  reads, and every value the schema refuses it reads as no context. The TypeScript reader is
  `packages/server-sdk`; its tests hold it to the schema with the same fixtures.
