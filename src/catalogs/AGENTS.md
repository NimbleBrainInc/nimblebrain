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
  listing entry keeps its inline `data` (`ListedEntry.data`) for that; nothing else reads it.
- **A row's setup may come from the connector list, nothing else.** A row shows setup the
  extension does not carry (an OAuth client portal and secret key, a broker's fields, secret
  headers), so a one-server row takes its `install` from the connector list's record of that
  server when the list holds one (`listings({ installed: false })`), else from the extension
  alone for `dcr`/`none`; a bare connector's row is projected from its inline record. An entry
  this shape cannot show is logged and left out; it still installs by address.
- **`curated` rows are a mounted directory's only.** With `NB_CURATED_CATALOG_DIR` set
  (`ConnectorCatalog.isMounted()`), its records no listing names are rows of the reserved
  catalog `curated` and install from the directory as plain connectors, with no record, until
  step 4 makes the directory a path catalog. The pinned connector list never yields a row.
- **Catalogs sit side by side.** The same server from two catalogs is a row under each; there
  is no precedence, dedupe or merge between catalogs.
- **`entry-extension.ts` (TypeBox) is the source of
  `schemas/catalog-entry-extension/v1/catalog-entry-extension.schema.json`**, which
  `listing.ts` validates against. Edit the TypeBox, run `bun run emit:catalog-entry-extension`;
  `bun run check:catalog-entry-extension` fails on drift. v1 only adds.
