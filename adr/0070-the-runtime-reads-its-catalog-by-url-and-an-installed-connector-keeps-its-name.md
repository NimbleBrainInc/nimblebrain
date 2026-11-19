# 0070. The runtime reads its catalog by URL, and an installed connector keeps its name

- Status: Proposed
- Date: 2026-11-19
- Serves: orchestrate remote MCP

## Context

ADR-0068 makes a catalog the source of what an instance can install, and a
catalog serves the MCP Registry API (`/v0.1/servers`). The runtime cannot read
it yet:

- `ConnectorCatalog` reads one directory of `ServerDetail` files
  (`NB_CURATED_CATALOG_DIR`, else the example built into the image), and
  validates each item as a bare `ServerDetail`. A Registry list item is
  `{ server, _meta }`, so a Registry response fails validation.
- NimbleBrain's fields are read from the server's own `_meta`
  (`ai.nimblebrain/connector`, `ai.nimblebrain/host`). A subregistry that
  mirrors a vendor's record unchanged puts its own fields in the list entry's
  `_meta`, under its own key, as the Registry's aggregator guidance says. The
  runtime never reads that level.

So a local install offers only the image's example, and a hosted instance
offers whatever its operator writes into the directory, by hand.

A catalog also has to name servers correctly. A server's identity in the MCP
Registry is the name its publisher registered under a namespace the publisher
proved it controls. A subregistry that invents a name inside a vendor's
namespace (`ai.exa/mcp`, where Exa published `ai.exa/exa`) claims a namespace it
does not hold. Correcting those names means a catalog entry's name changes after
connectors were installed from it.

A connector's name is load-bearing after install. `slugifyServerName` of the
catalog name is the `serverName` that keys the workspace's connector row, the
tool namespace the model sees (`<serverName>__<tool>`), its OAuth records,
tool permissions and personal-connector grants (ADR-0006), hook registrations,
notification cursors, skill overlay paths, the globs in tasks' `allowedTools`,
and the tool names recorded in conversation history. A recorded event is a
record and is never rewritten (ADR-0034). `bindCatalogEntry` links a row to its
catalog entry by that name alone, so a renamed entry leaves every row installed
under the old name `uncatalogued`: still running, without its catalog's
placements, hooks or minted credential.

## Decision

**The runtime reads its catalog from a URL that serves the MCP Registry API.
An installed connector keeps the name it was installed under, and a catalog
entry binds it by its current name or any name it was installed under before.**

### Reading a catalog by URL

- **A catalog source is a URL or a directory.** Configuration lists the
  sources in order. A URL source is read as `GET <url>/v0.1/servers`, following
  `nextCursor`. A directory source is read as it is today (ADR-0020). When two
  sources carry the same name, the earlier source wins, so an operator's own
  directory can sit before a public catalog and override or add to it.
- **The list entry is the unit.** Each `{ server, _meta }` item is a catalog
  entry. Its `server` is validated as a `ServerDetail`, as a file's item is now.
- **NimbleBrain's fields come from the list entry first.** The runtime reads
  `ai.nimblebrain/connector` and `ai.nimblebrain/host` from the entry's `_meta`,
  then from the server's own `_meta`. A mirrored vendor record stays unchanged
  and still carries the catalog's auth and placements, and a server the catalog
  authors, or an operator's file, keeps working as it does.
- **A URL source is fetched, not read per request.** The runtime fetches it at
  boot and on an interval, and writes the result to the work dir. Catalog reads
  come from that copy, so a request never waits on the network. The release
  image carries a copy of the default catalog taken at build. An instance that
  has never reached its catalog reads that copy, and a failed fetch keeps the
  last good one.
- **A local install's default source is NimbleBrain's catalog.** It replaces
  the example built into the image. A deployed instance's sources are its
  operator's configuration.

### Names

- **A catalog names a server by its publisher's registered name.** A vendor's
  published server is mirrored under its upstream name. A server no one has
  published is listed under the catalog publisher's own namespace, and moves to
  the vendor's name when the vendor publishes one.
- **An installed connector's `serverName` is fixed at install.** Nothing
  rewrites it: not the row, its credentials, permissions, grants, hooks,
  cursors, overlays, task globs, or history. A new install takes the slug of the
  entry's current name.
- **An entry lists the names it was installed under before.** The list entry's
  `_meta["ai.nimblebrain/connector"].previousNames` holds the earlier catalog
  names. `bindCatalogEntry` binds a row whose `serverName` is the slug of the
  entry's name or of any previous name. A brokered row binds when its stored
  `connectorId` is the entry's name or a previous one. The stored
  `connectorId` keeps locating the broker's state, and the workspace's
  static OAuth client is found under the entry's name, then its previous names.
- **A previous name is never reused** for another server in the same catalog.
  The catalog's build refuses a name that is another entry's previous name.

## Consequences

- A local install offers what NimbleBrain's catalog offers, with no CLI change.
  The CLI keeps starting the runtime and calling it.
- A hosted instance can read the public catalog and its operator's directory
  together. The platform's own fleet connectors stay out of the public catalog
  and come from the operator's source.
- Correcting a catalog's names changes nothing for an installed connector. A
  workspace may then hold an older install under one tool namespace while a
  newer one in another workspace uses the new namespace. Both bind to the same
  entry.
- The connector's tool namespace follows the catalog name at install. Long
  names make long tool names; nothing here shortens them.
- The runtime makes network requests to its catalog sources. An instance with
  no network keeps its image's copy.
- A brokered connector whose provider this instance has not configured still
  renders and refuses at install, as today. Choosing which index an instance
  reads, so it lists only what it can install (ADR-0068's policy), is separate.

## Alternatives considered

- **Renaming installed connectors at boot.** The name keys a dozen stores, and
  recorded history cannot change (ADR-0034), so a rename leaves tool names in
  history that no connector answers to, and an interrupted rename splits one
  connector's state across two names.
- **Keeping the names the catalog invented.** It claims vendors' namespaces in
  the MCP Registry's own API, and diverges from the record every other client
  reads.
- **The CLI fetching the catalog and writing the directory.** The CLI is
  versioned apart from the runtime (ADR-0064) and would write a format it does
  not own; a deployed instance would still need another path.
- **Reading the URL on every catalog read.** It puts a network call on Browse
  and install, and an outage of the catalog empties every instance's catalog.
- **A separate binding id stored on each row.** Names already identify rows;
  aliases on the entry solve the rename without migrating rows.
