/**
 * Catalog items with real artifacts, for install tests (ADR-0077): an Agent
 * Plugin archive carrying `plugin.json`, `mcp.json`, a server record per server
 * under `ai.nimblebrain/servers/`, skills and starters, and listing entries whose
 * `digest` is the artifact's own, so install can fetch and verify it.
 */

import { createHash } from "node:crypto";
import type { ServerDetail } from "../../src/connectors/catalog/server-detail.ts";
import { canonicalJsonBytes } from "../../src/util/jcs.ts";
import { AGENT_PLUGINS_MANIFEST_SCHEMA, zip } from "./plugin-catalog.ts";

export interface FixtureServer {
  /** Registry name. */
  name: string;
  url: string;
  /** `_meta["ai.nimblebrain/connector"]`. */
  meta?: Record<string, unknown>;
  /** `_meta["ai.nimblebrain/host"]`. */
  host?: Record<string, unknown>;
  /** The record's `title`; default `<name> title`. */
  title?: string;
  /** Run locally instead: `mcp.json` names a command. */
  stdio?: boolean;
}

/** A `ServerDetail` the way the catalog writes one into an archive. */
export function serverRecord(server: FixtureServer): ServerDetail {
  return {
    name: server.name,
    title: server.title ?? `${server.name} title`,
    description: `${server.name} server`,
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: server.url }],
    ...(server.meta || server.host
      ? {
          _meta: {
            ...(server.meta ? { "ai.nimblebrain/connector": server.meta } : {}),
            ...(server.host ? { "ai.nimblebrain/host": server.host } : {}),
          },
        }
      : {}),
  };
}

/** A plugin archive. */
export function pluginZip(opts: {
  name: string;
  servers?: Record<string, FixtureServer>;
  /** Folder → SKILL.md. */
  skills?: Record<string, string>;
  starters?: Array<{ title: string; text: string }>;
}): Uint8Array {
  const servers = opts.servers ?? {};
  const files: Record<string, string> = {
    "plugin.json": JSON.stringify({
      $schema: AGENT_PLUGINS_MANIFEST_SCHEMA,
      name: opts.name,
      description: `${opts.name} plugin`,
      extensions: {
        "ai.nimblebrain": {
          servers: Object.fromEntries(Object.entries(servers).map(([k, s]) => [k, s.name])),
          ...(opts.starters ? { conversationStarters: opts.starters } : {}),
        },
      },
    }),
  };
  if (Object.keys(servers).length > 0) {
    files["mcp.json"] = JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: Object.fromEntries(
        Object.entries(servers).map(([k, s]) => [
          k,
          s.stdio
            ? { type: "stdio", command: "node", args: ["server.js"] }
            : { type: "streamable-http", url: s.url },
        ]),
      ),
    });
    for (const [key, server] of Object.entries(servers)) {
      files[`ai.nimblebrain/servers/${key}.json`] = JSON.stringify(serverRecord(server));
    }
  }
  for (const [folder, body] of Object.entries(opts.skills ?? {})) {
    files[`skills/${folder}/SKILL.md`] = body;
  }
  return zip(files);
}

/** A SKILL.md, bound to server key `server` when given. */
export function skillMd(name: string, opts: { server?: string; body?: string } = {}): string {
  const nb = opts.server ? `metadata:\n  nimblebrain:\n    server: ${opts.server}\n` : "";
  return `---\nname: ${name}\ndescription: How to use ${name}.\n${nb}---\n\n${opts.body ?? `Use ${name} carefully.`}\n`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A listing entry for an artifact served at `${base}/artifacts/<name>/<hex>`. */
export function artifactEntry(opts: {
  name: string;
  bytes: Uint8Array;
  base: string;
  type?: string;
  servers?: Record<string, { name: string; auth: string }>;
  /** Overrides the true digest, to list a wrong one. */
  digest?: string;
}): { entry: Record<string, unknown>; path: string } {
  const hex = sha256Hex(opts.bytes);
  const path = `/artifacts/${opts.name}/${hex}`;
  return {
    path,
    entry: {
      identifier: `urn:air:catalog.test:${opts.name}:plugin`,
      displayName: opts.name,
      type: opts.type ?? "application/agent-plugins+zip",
      url: `${opts.base}${path}`,
      digest: opts.digest ?? `sha256:${hex}`,
      description: `${opts.name} item`,
      extensions: { "ai.nimblebrain": { servers: opts.servers ?? {} } },
    },
  };
}

/** A bare connector's entry: its inline record and the digest of that record's canonical form. */
export function bareConnectorEntry(name: string, server: FixtureServer): Record<string, unknown> {
  const data = serverRecord(server);
  return {
    identifier: `urn:air:catalog.test:${name}:server`,
    displayName: name,
    type: "application/vnd.nimblebrain.server+json",
    data,
    digest: `sha256:${sha256Hex(canonicalJsonBytes(data))}`,
  };
}
