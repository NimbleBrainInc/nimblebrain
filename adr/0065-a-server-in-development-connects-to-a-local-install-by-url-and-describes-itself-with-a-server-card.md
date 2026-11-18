# 0065. A server in development connects to a local install by URL, and describes itself with a Server Card

- Status: Accepted
- Date: 2026-11-17
- Serves: run NimbleBrain on a developer's machine; build for NimbleBrain

## Context

What a developer builds for NimbleBrain is an MCP server, and the last step of
building one is seeing it work inside NimbleBrain. The documented way
(`server-sdk/quickstart`, `apps/local-dev`) is to add
`{ "url": "http://127.0.0.1:8000/mcp", "serverName": "…" }` to the workspace's
`workspace.json`, set `allowInsecureRemotes`, and run `bun run dev` from a
source checkout. `npx nimblebrain` is now the default way to run NimbleBrain
locally, and on that install the documented way does not work at all:

- The work dir is a Docker volume, so `workspace.json` and `nimblebrain.json`
  are not files the developer can open.
- Inside the container `127.0.0.1` is the container, not the developer's machine.
- `host.docker.internal`, the name that does reach the host, is refused over
  `http` by the HTTPS rule (`src/connectors/runtime/url-validator.ts`):
  `allowInsecureRemotes` admits plain `http` only to `localhost`, `127.0.0.1`
  and `::1`.
- `manage_connectors` has a `direct-url` install kind that answers "not yet
  supported", and the tool is app-only, so no agent can call it over
  `/mcp/<wsId>`.

A connector added outside the catalog would also show bare: the shell names a
connector from its catalog entry's `title` and `icons`
(`src/connectors/catalog/projection.ts`) and otherwise falls back to its server
name, with no icon and no placements.

Two rules frame the choice. Connectors on a deployed instance come from the
catalog an operator controls (#1130), and that should not change. The CLI covers
setup and running only; anything inside a running instance belongs to the web UI
and `/mcp/<wsId>` (`packages/cli/AGENTS.md`).

Options considered:

- **The CLI edits `workspace.json` in the volume and restarts the container.**
  The CLI is versioned apart from the runtime (ADR-0064), so it would write a
  file format it does not own; the restart drops open conversations; and it
  races the runtime writing the same file.
- **A tool on `/mcp/<wsId>`.** Any agent could add a server, including the
  workspace's own chat agent, which reads untrusted content: an injected
  instruction could point the runtime at any port on the developer's machine.
  The same holds for a browser page whose hostname rebinds to `127.0.0.1`:
  it is same-origin to the browser, and the `dev` adapter authenticates it.
- **A dev catalog directory mounted from the host.** `NB_CURATED_CATALOG_DIR`
  replaces the built-in catalog, and mounting it needs a Compose change the CLI
  may not make.
- **A web-UI "Add by URL" form only.** Safe, but a person must switch to the
  browser for every new server, and a coding agent cannot finish the loop.
- **Metadata from a `server.json` path the developer passes.** The file lives in
  a repo, so every add needs a path; it is a second input beside the URL.
- **Metadata from the handshake alone.** Under `2026-07-28`, `serverInfo`
  carries `title`, `description`, `icons` and `websiteUrl`, but not the
  `ai.nimblebrain/host` block, so an app would get no sidebar placement.

## Decision

A server in development is added to a local install by URL, through the
runtime, and describes itself with an MCP Server Card.

- **The runtime owns the add.** `manage_connectors` implements `direct-url`:
  it checks the URL, fetches the server's card, connects, and writes one row to
  the workspace's `connectors` in `workspace.json`, as a catalog install does,
  with no restart. The row holds the URL the developer gave, the server name,
  and the title, description, icon and `ui` taken from the card.
- **Only on a local install.** `direct-url` and the loopback exception below are
  on only when both hold: `NB_HOST_LOOPBACK` is set, which only the release
  Compose file does, and `instance.json` uses the `dev` adapter, which the CLI
  writes and which already publishes the port on `127.0.0.1` only. Everywhere
  else `direct-url` keeps refusing, and connectors come from the catalog.
- **The runtime reaches the host.** The release Compose file maps
  `host.docker.internal` to the host gateway and sets `NB_HOST_LOOPBACK` to it.
  When the gate holds, every runtime dial of a stored loopback URL (the card
  fetch, the MCP transport, OAuth discovery) goes to that alias, through one
  helper, and keeps the original `Host` header. The stored URL stays as
  typed, so the same row works under `bun run dev`. The exception covers
  loopback names over `http` only; private ranges and metadata hosts stay
  refused. Installs get it through `npx nimblebrain update`.
- **The CLI is a thin client.** `npx nimblebrain mcp add <url> [--name]`,
  `mcp list` and `mcp remove <name>` call the `manage_connectors` actions the web
  shell's Connectors page calls, on the local instance, in the workspace `init`
  connected (`--workspace` overrides it), and print the answer in the CLI's JSON
  contract. No new `/v1` route. The CLI stores nothing and
  restarts nothing. `status` reports `host_loopback`, so an agent can tell when
  an install needs `update`. The CLI rule becomes: setup and running, plus a
  thin client of the local instance's API for developing against it; the
  runtime owns what it stores. A coding agent can run `mcp add` because it holds
  a shell on the developer's machine; the workspace's chat agent cannot reach it.
- **A browser page cannot reach it.** The `/v1` tool-call routes chain
  `rejectUntrustedOrigin`, as `/mcp/<wsId>` does, so a DNS-rebound page is
  refused before authentication. The web shell's own origin is trusted, and the
  CLI sends no `Origin`.
- **The server describes itself with a Server Card** (SEP-2127, extension
  `io.modelcontextprotocol/server-card`). The runtime requests
  `GET <url>/server-card` with `Accept: application/mcp-server-card+json`, and
  takes `title`, `description`, `icons` and the placements in
  `_meta["ai.nimblebrain/host"]`. Of that block only `placements` is used:
  `hooks`, `notifications`, `admin_tools` and `record_arguments` are operator
  grants read from a catalog entry only. The card is advisory: where the live
  connection reports a value, it wins, and nothing in the card decides access.
  With no card, the name comes from `serverInfo`, then the server name, with no
  placements. On a local install a card's icon may be a `data:` URI or a
  loopback URL.
- **The server SDK serves the card.** `nimblebrain-server-sdk` serves
  `/server-card` under the MCP path from what the server already declares (name,
  title, version, icons, its `ai.nimblebrain/host` block), so the card cannot
  drift from the server. The registry `server.json` an operator puts in the
  catalog shares the card's field names; it is built from the same metadata and
  adds the production `remotes`.
- **The web UI gets the same add** on the Connectors page, calling the same
  path, for a person who is not working through an agent.

## Consequences

- The build loop on an `npx nimblebrain` install is: run the server, then
  `npx nimblebrain mcp add http://127.0.0.1:8000/mcp`, once per server. The row
  survives `down`, `up` and `update`, and a restarted server reconnects at the
  same URL.
- A deployed instance does not change: no `direct-url`, no loopback exception,
  connectors from the catalog.
- A server whose card names a sidebar placement gets it without a catalog
  entry. A connector with no catalog entry keeps its stored `ui` across boots
  (`catalog-ui.ts`); a `serverName` that names a catalog entry is refused, since
  boot would clear its `ui`.
- On Linux, `host-gateway` is the bridge address, not the host's loopback, so a
  server bound to `127.0.0.1` is not reachable; the docs say to bind the bridge
  or `0.0.0.0`, and that `0.0.0.0` can expose it to the network.
- Server Cards are new and few clients read them. The runtime both serves cards
  (through the SDK) and reads them, so a field change in the extension is
  absorbed on both ends. The card's schema is the extension repository's, not
  ours.
- `quickstart`, `apps/local-dev`, `cli/nimblebrain`, `config/environment` and
  `host/manifest` describe this path, and `allowInsecureRemotes` is described as
  what it is: plain `http` to loopback names, on any instance that sets it.
  `packages/cli/AGENTS.md` takes the amended CLI rule, and the `nimblebrain`
  skill's `references/cli.md` documents the `mcp` commands.
- To check while building: that Bun's `fetch` lets the transport set the `Host`
  header; how a server inside WSL2 is reached; that a server with no auth
  connects with no credential stored.
