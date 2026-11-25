# Conversations plugin

Chat history for NimbleBrain: an [Agent Plugins](https://agent-plugins.org) 1.0.0 plugin with
one MCP server that implements the `ai.nimblebrain.conversations` 1.0 contract
([`contracts/conversations/CONTRACT.md`](../../contracts/conversations/CONTRACT.md)) on the
local filesystem.

- **Public tools** (people and agents): `list`, `get`, `search`, `update`, `stats`, `export`.
- **Private tools** (the host only): `create`, `events`, `append_events`, `delete`,
  `delete_workspace`. Any other caller gets `forbidden`.
- **Screen**: `ui://conversations/browser`.

## Run it

From a checkout of this repository, after `bun install` at its root.

Over stdio, as a host starts it from `mcp.json`:

```bash
packages/conversations/bin/nb-conversations --data-dir ./data
```

Each request names its context in `params._meta["ai.nimblebrain/scope"]`:

```json
{ "workspaceId": "ws_0123456789abcdef", "ownerId": "user_1",
  "conversationId": "conv_0123456789abcdef", "principal": "host" }
```

Over Streamable HTTP, at `/mcp`. Every request presents the host's credential:

```bash
NB_CONVERSATIONS_TOKEN=change-me \
  packages/conversations/bin/nb-conversations --data-dir ./data --http 8080 [--host 127.0.0.1]
```

A request without `Authorization: Bearer $NB_CONVERSATIONS_TOKEN` is refused with 401. The
context is `params._meta["ai.nimblebrain/scope"]` when a request states one, else the headers
`x-nb-workspace-id`, `x-nb-owner-id`, `x-nb-conversation-id` and `x-nb-principal`.

`--screen <file>` serves a built screen as `ui://conversations/browser`; without one the
resource is a placeholder page.

## Data

```
<data>/workspaces/<workspaceId>/conversations/<ownerId>/<conversationId>.jsonl
```

Line 1 is the conversation's header and every later line one event. A workspace exists when
its directory does: create `<data>/workspaces/<workspaceId>/` before the first `create` there.
The layout matches the NimbleBrain runtime's under its work directory.

## Check it

```bash
mkdir -p ./data/workspaces/ws_0123456789abcdef ./data/workspaces/ws_fedcba9876543210
bun --no-env-file contracts/conversations/runner/conformance.ts \
  --server http://127.0.0.1:8080/mcp --header "authorization=Bearer change-me" \
  --carriage headers --workspace ws_0123456789abcdef --owner user_1 \
  --scratch-workspace ws_fedcba9876543210
```
