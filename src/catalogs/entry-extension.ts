/**
 * The `ai.nimblebrain` extension of an AI Catalog entry: the TypeBox authoring
 * source for `schemas/catalog-entry-extension/v1/catalog-entry-extension.schema.json`
 * (ADR-0077).
 *
 * It is the second shape of the one extension key. A plugin manifest's
 * extension (`src/plugins/extension.ts`) maps each server key to a registry
 * name; a catalog entry's maps each server key to `{name, auth}`, so Browse can
 * show and gate an entry without opening its artifact. A reader knows which
 * applies from where the extension sits.
 *
 * `bun run emit:catalog-entry-extension` writes the JSON, and
 * `bun run check:catalog-entry-extension` (in `verify:static`) fails when the
 * committed JSON differs from what this source emits. Every field is optional
 * and the objects are open, so a later v1 may add fields an older reader ignores.
 */

import { resolve } from "node:path";
import { type Static, Type } from "@sinclair/typebox";

export const CATALOG_ENTRY_EXTENSION_SCHEMA_ID =
  "https://schemas.nimblebrain.ai/catalog-entry-extension/v1/catalog-entry-extension.schema.json";

/** Where the published form is kept: `schemas/` mirrors what its `$id` serves. */
export const CATALOG_ENTRY_EXTENSION_SCHEMA_FILE = resolve(
  import.meta.dir,
  "../../schemas/catalog-entry-extension/v1/catalog-entry-extension.schema.json",
);

/** The key the extension sits under in an entry's `extensions`. */
export const NIMBLEBRAIN_EXTENSION_KEY = "ai.nimblebrain";

export const CatalogEntryServer = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      description: 'The server\'s registry name, e.g. "com.example/mcp".',
    }),
    auth: Type.String({
      pattern: "^[a-z][a-z0-9-]*$",
      description:
        "How the server signs in, so a host can say what an install will ask for: `dcr` (the host registers its own OAuth client), `none`, `static` (an OAuth client the operator registers first), `provider` (a credential the host mints), or the id of the broker that holds the session (e.g. `composio`), which only a host that has that broker can install.",
    }),
  },
  { description: "One server the listed item connects: its registry name and how it signs in." },
);
export type CatalogEntryServer = Static<typeof CatalogEntryServer>;

export const CatalogEntryExtension = Type.Object(
  {
    $schema: Type.Optional(Type.Literal(CATALOG_ENTRY_EXTENSION_SCHEMA_ID)),
    iconUrl: Type.Optional(
      Type.String({
        minLength: 1,
        description: "An http(s) URL of the item's icon, shown where the item is listed.",
      }),
    ),
    category: Type.Optional(
      Type.String({
        minLength: 1,
        description: 'The category the item is listed under, as display text, e.g. "Sales & CRM".',
      }),
    ),
    servers: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), CatalogEntryServer, {
        // A key the pattern does not match (one with a line break) is refused,
        // so every value in the map is a server.
        additionalProperties: false,
        description:
          "The item's servers, by server key (the key the artifact uses for the server): each one's registry name and auth. It describes what the artifact holds so the listing can be read without it; an install reads the servers from the verified artifact, never from here.",
      }),
    ),
    nimblebrainOnly: Type.Optional(
      Type.Boolean({
        description:
          "True when only NimbleBrain can run the item: a server it names is brokered, or needs an operator's own OAuth app. It describes the item; it grants nothing.",
      }),
    ),
  },
  {
    title: "NimbleBrain catalog-entry extension",
    description:
      "The `ai.nimblebrain` entry of an AI Catalog entry's `extensions`: what a NimbleBrain host shows and gates a listed item on without opening its artifact. A listing selects what installs (the entry's `url`, `digest` or inline `data`); what an install produces comes only from the verified artifact, so nothing here is read at install or grants anything. A plugin manifest's `extensions[\"ai.nimblebrain\"]` has its own schema (plugin-extension/v1). Readers ignore fields they do not know.",
  },
);
export type CatalogEntryExtension = Static<typeof CatalogEntryExtension>;

/** The published JSON Schema: this source as JSON, with its dialect and `$id`. */
export function catalogEntryExtensionJsonSchema(): Record<string, unknown> {
  const wire = JSON.parse(JSON.stringify(CatalogEntryExtension)) as Record<string, unknown>;
  const { title, description, ...rest } = wire;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CATALOG_ENTRY_EXTENSION_SCHEMA_ID,
    title,
    description,
    ...rest,
  };
}
