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
- **Install still reads the connector list** (`ConnectorCatalog`) in this step: a row's `id`
  is its server's registry name and its `install` is that record's. So a listed entry is a
  row only when it names exactly one server the connector list holds, and the list's records
  no listing names are rows of the reserved catalog `curated`. When install fetches the
  artifact instead, drop that join and the `curated` rows.
- **Catalogs sit side by side.** The same server from two catalogs is a row under each; there
  is no precedence, dedupe or merge between catalogs.
- **`entry-extension.ts` (TypeBox) is the source of
  `schemas/catalog-entry-extension/v1/catalog-entry-extension.schema.json`**, which
  `listing.ts` validates against. Edit the TypeBox, run `bun run emit:catalog-entry-extension`;
  `bun run check:catalog-entry-extension` fails on drift. v1 only adds.
