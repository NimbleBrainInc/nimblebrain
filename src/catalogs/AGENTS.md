# Catalogs

Scope: `src/catalogs/`. The AI Catalog listings the operator names in `catalogs`
(`src/config/catalogs.ts`), and Browse built from them (ADR-0077). The domain terms are
*Catalog* and *Catalog policy* in `CONTEXT.md`.

- **`reader.ts` is the one reader of a listing.** Nothing else fetches or parses a catalog's
  AI Catalog. URL sources go through `fetchBounded` (`src/util/pinned-fetch.ts`); a pinned
  listing's bytes are used only when their sha256 is the pin, and it is never read again.
- **Never fatal, never empty silently.** A failed read keeps the copy in memory, else the
  work-directory cache (`cache/catalogs/<digest of source>/listing.json`), else lists nothing
  with an error Browse shows. A bad entry is dropped and logged; one bad entry never empties
  a listing.
- **Browse reads listings, never artifacts.** Building a row never opens a plugin archive or
  any entry `url`. What a row shows comes from the entry; its status from the extension's
  `servers[].auth` (`browseStatus`). An entry's fields grant nothing at install.
- **Install reads the item's artifact, never a row.** A row is addressed `name@catalog`, and
  install (`src/tools/plugin-install.ts`) looks the address up in the cached listing, verifies
  the artifact against `digest`, and connects each server from the archive's own record. A
  listing entry keeps its inline `data` (`ListedEntry.data`) for that, and for
  `listed-records.ts` below.
- **Every plugin entry of one server is a row; setup it lacks is read from its one artifact,
  later.** A row's status is the listing's (`servers[].auth`). A bare connector's row is
  projected from its inline record, which carries every fact the web asks for before install
  (an OAuth client portal and secret key, a broker's fields, secret headers). A plugin entry's
  row has only its server's auth; for any auth but `dcr`/`none` it is marked
  `setupFromArtifact`, and `manage_connectors get_setup` (and `set_oauth_client` by
  `address`) reads the record from that one plugin's verified artifact when a person opens
  set-up or installs, cached by digest. Never during Browse. The extension is not widened to
  carry setup: the artifact's record already does. An entry with several servers or a type
  Browse cannot show is logged and left out, and still installs by address.
- **A listing's bare connectors are the connector list's records** for a connector no plugin
  record supplies (`listed-records.ts`, read by `ConnectorCatalog` after the owner's records,
  its only other source): verified against `digest`, schema-checked, and one the safety
  scrub refuses kept only for its `adminTools` restriction. An edit to an unpinned listing
  reaches them at its next read. No list or pin is compiled into the image and no
  `connectors.yaml` is read at runtime; `src/connectors/catalog/read.ts` reads one only for
  the converter.
- **The default catalog is `<NB_PLUGIN_CATALOG_URL>/.well-known/ai-catalog.json`**, read live,
  used only when `catalogs` is absent. The variable is its base URL and nothing else, so tests
  (`test/preload.ts` points it at a refusing port) and dev can aim it without a block.
- **A path catalog replaces a mounted connector directory.** There is no `curated` catalog,
  no reserved name, and no install from a directory. An operator converts a directory of
  `{servers: [...]}` files with `bun run catalog:convert` and mounts the listing it writes.
- **Catalogs sit side by side.** The same server from two catalogs is a row under each; there
  is no precedence, dedupe or merge between catalogs.
- **One connection name is one server.** Two different registry names that slugify to one
  connection would install into each other's connection, so `snapshots()` drops the entry
  naming the later one (configuration order, then listing order) with a diagnostic on its
  snapshot (`refuseConnectionCollisions`). A dropped entry makes its listing not clean, so it is
  neither "no longer offered" nor removed by the required reconcile.
- **`entry-extension.ts` (TypeBox) is the source of
  `schemas/catalog-entry-extension/v1/catalog-entry-extension.schema.json`**, which
  `listing.ts` validates against. Edit the TypeBox, run `bun run emit:catalog-entry-extension`;
  `bun run check:catalog-entry-extension` fails on drift. v1 only adds.
