/**
 * The `ai.nimblebrain` extension of an Agent Plugins manifest: the TypeBox
 * authoring source for `schemas/plugin-extension/v1/plugin-extension.schema.json`.
 *
 * The JSON is the published form (its `$id` below) and is what the loader
 * validates against; this file is where it is written, and where its types
 * come from. `bun run emit:plugin-extension` writes the JSON, and
 * `bun run check:plugin-extension` (in `verify:static`) fails when the
 * committed JSON differs from what this source emits.
 *
 * It describes a manifest (`plugin.json`) only. An AI Catalog entry's
 * `extensions["ai.nimblebrain"]` has its own shape and schema
 * (`src/catalogs/entry-extension.ts`, ADR-0077).
 *
 * Every field is optional and the objects are open, so a catalog plugin that
 * carries only `servers` and `conversationStarters` is valid, and a later v1
 * may add fields that an older reader ignores.
 */

import { resolve } from "node:path";
import { type Static, Type } from "@sinclair/typebox";

export const PLUGIN_EXTENSION_SCHEMA_ID =
  "https://schemas.nimblebrain.ai/plugin-extension/v1/plugin-extension.schema.json";

/** Where the published form is kept: `schemas/` mirrors what its `$id` serves. */
export const PLUGIN_EXTENSION_SCHEMA_FILE = resolve(
  import.meta.dir,
  "../../schemas/plugin-extension/v1/plugin-extension.schema.json",
);

/** The most starters a plugin carries, and the longest title and text. */
export const MAX_CONVERSATION_STARTERS = 4;
export const MAX_STARTER_TITLE = 60;
export const MAX_STARTER_TEXT = 500;

const CONTRACT_ID_PATTERN = "^[a-z0-9]+(\\.[a-z0-9-]+)+$";
const CONTRACT_VERSION_PATTERN = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$";

const ContractId = Type.String({
  pattern: CONTRACT_ID_PATTERN,
  description:
    'A contract\'s permanent reverse-DNS id, e.g. "ai.nimblebrain.conversations". Never a URL: where a contract is published is derived from its id.',
});

const ContractVersion = Type.String({
  pattern: CONTRACT_VERSION_PATTERN,
  description:
    'The contract version as "major.minor". An implementation at M.m meets a need for N.n when M equals N and m is at least n.',
});

export const ConversationStarter = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      maxLength: MAX_STARTER_TITLE,
      description: 'The short action a person reads, e.g. "Summarize my unread email".',
    }),
    text: Type.String({
      minLength: 1,
      maxLength: MAX_STARTER_TEXT,
      description: "What the host sends when the person chooses it.",
    }),
  },
  {
    description:
      "One conversation starter: something the plugin's tools can do, offered to a person who has the plugin and does not know what to ask.",
  },
);
export type ConversationStarter = Static<typeof ConversationStarter>;

export const ContractImplementation = Type.Object(
  {
    contract: ContractId,
    version: ContractVersion,
    server: Type.String({
      minLength: 1,
      description:
        "The key in this plugin's mcp.json `mcpServers` of the one server that implements the contract: it serves the contract's public and private tools. Always an mcp.json key, since mcp.json is where the host learns how to start or reach a server; a server named only by its registry name in `servers` has no address the host can reach at boot. Which tools are private is the contract's decision: the host never offers them to agents, and the server refuses them to any caller but the host.",
    }),
  },
  {
    description:
      "A contract this plugin implements. Whether several enabled plugins may implement one contract is the contract's own cardinality, never the plugin's.",
  },
);
export type ContractImplementation = Static<typeof ContractImplementation>;

export const ContractRequirement = Type.Object(
  {
    contract: ContractId,
    version: ContractVersion,
    optional: Type.Optional(
      Type.Boolean({
        description:
          "The plugin uses the contract when an enabled plugin implements it, and works without it. Default false: an unmet requirement refuses the boot.",
      }),
    ),
  },
  {
    description:
      "A contract (never a plugin) this plugin uses from an enabled plugin that implements it at a compatible version.",
  },
);
export type ContractRequirement = Static<typeof ContractRequirement>;

export const PluginExtension = Type.Object(
  {
    $schema: Type.Optional(Type.Literal(PLUGIN_EXTENSION_SCHEMA_ID)),
    servers: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1 }),
        Type.String({
          minLength: 1,
          description: 'The server\'s registry name, e.g. "com.example/mcp".',
        }),
        {
          description:
            "The plugin's servers that have a registry entry: server key to registry name. A key here is the same key as in mcp.json when the plugin also states how to reach the server there; a server only NimbleBrain can reach (a brokered connector) is named here alone. Auth, placements (`ai.nimblebrain/host`) and every other runtime field come from that registry entry's `_meta`, never from this extension.",
        },
      ),
    ),
    conversationStarters: Type.Optional(
      Type.Array(ConversationStarter, {
        maxItems: MAX_CONVERSATION_STARTERS,
        description:
          "What a host offers a person who has the plugin and does not know what to ask. Titles are unique within a plugin.",
      }),
    ),
    nimblebrainOnly: Type.Optional(
      Type.Boolean({
        description:
          "True when only NimbleBrain can run the plugin: a server it names is brokered, or needs an operator's own OAuth app. It describes the plugin; it grants nothing.",
      }),
    ),
    implements: Type.Optional(
      Type.Array(ContractImplementation, {
        description:
          "The contracts this plugin implements, each at most once. A host binds a contract it consumes when the version meets the one it needs, and ignores a contract it does not consume.",
      }),
    ),
    requires: Type.Optional(
      Type.Array(ContractRequirement, {
        description:
          "The contracts this plugin uses from other enabled plugins. A requirement no enabled plugin meets refuses the boot unless it is optional.",
      }),
    ),
  },
  {
    title: "NimbleBrain plugin extension",
    description:
      "The `ai.nimblebrain` entry of an Agent Plugins 1.0 manifest's `extensions` (plugin.json). It names the plugin's registry servers, its conversation starters, and the contracts it implements and requires. It declares capabilities, never trust: whether a plugin is a system plugin, and where its servers run, are the operator's (nimblebrain.json `plugins`). An AI Catalog entry's `extensions[\"ai.nimblebrain\"]` has its own schema (catalog-entry-extension/v1). Other hosts ignore it. Readers ignore fields they do not know.",
  },
);
export type PluginExtension = Static<typeof PluginExtension>;

/** The published JSON Schema: this source as JSON, with its dialect and `$id`. */
export function pluginExtensionJsonSchema(): Record<string, unknown> {
  const wire = JSON.parse(JSON.stringify(PluginExtension)) as Record<string, unknown>;
  const { title, description, ...rest } = wire;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: PLUGIN_EXTENSION_SCHEMA_ID,
    title,
    description,
    ...rest,
  };
}
