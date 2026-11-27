# Files plugin

The files people and agents keep in NimbleBrain: an [Agent Plugins](https://agent-plugins.org)
1.0.0 plugin with one MCP server that implements the `ai.nimblebrain.files` 1.0 contract
([`contracts/files/CONTRACT.md`](../../contracts/files/CONTRACT.md)) on the local filesystem.

- **Public tools** (people and agents): `list`, `search`, `info`, `read`, `create`, `tag`,
  `move`, `delete`, `create_folder`, `update_folder`, `delete_folder`.
- **Private tools** (the host only): `begin_upload`, `complete_upload`, `resolve`,
  `delete_workspace`. Any other caller gets `forbidden`.
- **Screen**: `ui://files/browser`. **Resource template**: `files://{id}`, which the host
  answers.

Bodies never cross MCP beyond `create`'s 4 MiB: the host PUTs an upload to the URL
`begin_upload` answers and completes it with `complete_upload`, and fetches a file from the
URL `resolve` answers.

## Run it

From a checkout of this repository, after `bun install` at its root.

Over stdio, as a host starts it from `mcp.json`:

```bash
packages/files/bin/nb-files --data-dir ./data
```

Transfer URLs are then served by a listener on `127.0.0.1`, on a port the OS picks. Each
request carries the host context
([`contracts/host-context/CONTEXT.md`](../../contracts/host-context/CONTEXT.md)) in
`params._meta["ai.nimblebrain/context"]`:

```json
{ "principal": "person", "workspaceId": "ws_0123456789abcdef", "ownerId": "user_1",
  "conversationId": "conv_0123456789abcdef" }
```

Over Streamable HTTP, at `/mcp`, every request presents the host's credential, and transfer
URLs are served on the same origin under `/t/`:

```bash
NB_FILES_TOKEN=$(openssl rand -hex 32) \
  packages/files/bin/nb-files --data-dir ./data --http 8080 [--host 127.0.0.1] \
  [--transfer-origin https://files.example.com]
```

`NB_FILES_TOKEN` is at least 32 characters; a request to `/mcp` without
`Authorization: Bearer $NB_FILES_TOKEN` is refused with 401. The token is `host` on every
tool, so the server listens on `127.0.0.1` unless `--host` names another address, and warns
when it does. The origin transfer URLs name is the listener's own unless
`--transfer-origin` says otherwise; that is the origin an operator lists for the binding.

| Flag | Default | Meaning |
|---|---|---|
| `--max-file-bytes <n>` | 26214400 | the largest upload `begin_upload` accepts |
| `--upload-ttl <s>` | 900 | how long an upload URL lives (at most 900) |
| `--download-ttl <s>` | 300 | how long a download URL lives (at most 300) |
| `--screen <file>` | `ui/dist/index.html` | the screen's built HTML |

The screen is `ui/`: `cd ui && bun install && bun run build` writes `ui/dist/index.html`.

## Data

```
<data>/workspaces/<workspaceId>/state.json         records, folders and uploads
<data>/workspaces/<workspaceId>/bodies/<fileId>     each file's body
<data>/workspaces/<workspaceId>/uploads/<uploadId>  the body last PUT to an open upload
```

## Conformance

```bash
bun --no-env-file contracts/files/runner/conformance.ts \
  --command bun --arg --no-env-file --arg packages/files/bin/nb-files \
  --arg --data-dir --arg ./scratch --arg --upload-ttl --arg 3 --arg --download-ttl --arg 3 \
  --workspace ws_conformance --owner usr_conformance
```
