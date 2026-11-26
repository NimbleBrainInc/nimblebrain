# Tasks plugin

Scheduled and unattended work for NimbleBrain: an [Agent Plugins](https://agent-plugins.org)
1.0.0 plugin with one MCP server that implements the `ai.nimblebrain.tasks` 1.0 contract
([`contracts/tasks/CONTRACT.md`](../../contracts/tasks/CONTRACT.md)) on the local filesystem.

- **Public tools** (people and agents): `create`, `update`, `delete`, `list`, `status`, `run`,
  `run_result`, `runs`, `cancel`, `upcoming`, `stats`, `run_batch`, `batch`, `batches`,
  `batch_control`.
- **Private tools** (the host only): `due`, `begin_run`, `end_run`, `offer_event`,
  `delete_workspace`. Any other caller gets `forbidden`.
- **Screen**: `ui://tasks/panel` and `ui://tasks/card`. **Change hint**:
  `tasks://due/<workspaceId>`, host only.

The host owns the clock and runs the work: it asks `due` what is owed, claims each occurrence
with `begin_run`, runs the work spec it is answered, and reports with `end_run`.

## Run it

From a checkout of this repository, after `bun install` at its root.

Over stdio, as a host starts it from `mcp.json`:

```bash
packages/tasks/bin/nb-tasks --data-dir ./data
```

Each request carries the host context
([`contracts/host-context/CONTEXT.md`](../../contracts/host-context/CONTEXT.md)) in
`params._meta["ai.nimblebrain/context"]`; a person's call to `create`, `update`, `run`,
`run_batch` or `batch_control` also carries the host's run grant:

```json
{ "principal": "person", "workspaceId": "ws_0123456789abcdef", "ownerId": "user_1",
  "grant": "<opaque, from the host>" }
```

Over Streamable HTTP, at `/mcp`, every request presents the host's credential:

```bash
NB_TASKS_TOKEN=$(openssl rand -hex 32) \
  packages/tasks/bin/nb-tasks --data-dir ./data --http 8080 [--host 127.0.0.1]
```

`NB_TASKS_TOKEN` is at least 32 characters; a request without
`Authorization: Bearer $NB_TASKS_TOKEN` is refused with 401. The token is `host` on every tool,
so the server listens on `127.0.0.1` unless `--host` names another address, and warns when it
does.

`--retention-days <n>` sets how long an ended run's data is kept (default 180), judged on the
`now` the host passes to `due`. The screen is `ui/`: `cd ui && bun install && bun run build`
writes `ui/dist/index.html`; `--screen <file>` serves another file.

## Data

```
<data>/workspaces/<workspaceId>/state.json      definitions, open runs, fences, batches, keys
<data>/workspaces/<workspaceId>/runs-<n>.jsonl  ended runs, up to the length state.json commits
<data>/workspaces/<workspaceId>/blobs/          inputs, answers, results, batch inputs
```

A workspace the host stamps exists: its directory is made on first use, and
`delete_workspace` removes it.

## Check it

```bash
bun --no-env-file contracts/tasks/runner/conformance.ts \
  --server http://127.0.0.1:8080/mcp --bearer-env NB_TASKS_TOKEN \
  --carriage meta --workspace ws_0123456789abcdef --owner user_1 \
  --scratch-workspace ws_fedcba9876543210
```
