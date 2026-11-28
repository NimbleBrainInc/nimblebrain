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
- **A row's setup comes from its listing, nothing else.** A bare connector's row is projected
  from its inline record, which carries every fact the web asks for before install (an OAuth
  client portal and secret key, a broker's fields, secret headers). A plugin entry's row takes
  only its one server's auth from the extension, so it is a row only for `dcr`/`none`; any
  other entry this shape cannot show is logged and left out, and still installs by address. A
  publisher lists a server that needs setup as a bare connector. The extension is not widened
  to carry setup: the record already does.
- **A listing's bare connectors are the connector list's records** for a connector no plugin
  record supplies (`listed-records.ts`, read by `ConnectorCatalog` after the owner's records
  and before the pinned list): verified against `digest`, schema-checked, and one the safety
  scrub refuses kept only for its `adminTools` restriction. An edit to an unpinned listing
  reaches them at its next read.
- **A path catalog replaces a mounted connector directory.** There is no `curated` catalog,
  no reserved name, and no install from a directory. An operator converts a directory of
  `{servers: [...]}` files with `bun run catalog:convert` and mounts the listing it writes.
- **Catalogs sit side by side.** The same server from two catalogs is a row under each; there
  is no precedence, dedupe or merge between catalogs.
- **`entry-extension.ts` (TypeBox) is the source of
  `schemas/catalog-entry-extension/v1/catalog-entry-extension.schema.json`**, which
  `listing.ts` validates against. Edit the TypeBox, run `bun run emit:catalog-entry-extension`;
  `bun run check:catalog-entry-extension` fails on drift. v1 only adds.
