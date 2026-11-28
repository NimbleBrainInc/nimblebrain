/**
 * Converting a connector list (`{servers: [ServerDetail, ...]}` YAML or JSON
 * files) into an AI Catalog listing whose entries are bare connectors
 * (ADR-0077, "A bare connector"): what an operator mounts as a path catalog.
 *
 * Each server becomes one entry of type `application/vnd.nimblebrain.server+json`
 * whose inline `data` is the server's record, unchanged, so it carries every
 * setup fact the record does (an OAuth client portal and secret key, a
 * broker's fields, secret headers). Its `digest` is `sha256:` and the hex
 * SHA-256 of the record's RFC 8785 canonical form, the digest install verifies.
 * What Browse shows (`displayName`, `description`, `tags`, the extension's
 * `iconUrl`, `category` and `servers`) is copied from the record.
 *
 * Strict: the list is checked with the runtime's own `validateCatalog`, and
 * any entry the runtime would drop fails the conversion, so a listing never
 * silently lacks a server its source named.
 */

import { SERVER_RECORD_TYPE } from "../../src/catalogs/listing.ts";
import { projectServerDetailToCatalogListing } from "../../src/connectors/catalog/projection.ts";
import { readCatalogEntries, validateCatalog } from "../../src/connectors/catalog/read.ts";
import {
  getNimbleBrainConnectorMeta,
  type ServerDetail,
} from "../../src/connectors/catalog/server-detail.ts";
import { slugifyServerName } from "../../src/connectors/runtime/paths.ts";
import { canonicalJsonBytes } from "../../src/util/jcs.ts";
import { sha256Hex } from "../../src/util/pinned-fetch.ts";
import { isHttpUrl } from "../../src/util/url.ts";

/** The AI Catalog `specVersion` the listing is written in. */
export const LISTING_SPEC_VERSION = "0.9";

export interface ConvertOptions {
  /** The publisher segment of each entry's `urn:air` identifier, and the listing's host. Default `local`. */
  publisher?: string;
  /** The listing's `host.displayName`. Default the publisher. */
  hostName?: string;
}

/** A connector list that cannot be converted, with every reason. */
export class ConnectorListError extends Error {
  constructor(readonly problems: string[]) {
    super(`the connector list has ${problems.length} problem(s):\n${problems.join("\n")}`);
  }
}

const PUBLISHER = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** The bare-connector entry for one server record. Throws when it is not installable. */
export function bareConnectorEntry(
  detail: ServerDetail,
  publisher: string,
): Record<string, unknown> {
  const listing = projectServerDetailToCatalogListing(detail);
  if (listing?.install.kind !== "remote-oauth") {
    throw new ConnectorListError([`${detail.name}: not installable as a remote MCP server`]);
  }
  const meta = getNimbleBrainConnectorMeta(detail);
  const name = slugifyServerName(detail.name);
  const iconUrl = detail.icons?.[0]?.src;
  const category = meta?.category?.trim();
  return {
    identifier: `urn:air:${publisher}:${name}:server`,
    displayName: detail.title ?? detail.name,
    description: detail.description,
    ...(meta?.tags && meta.tags.length > 0 ? { tags: meta.tags } : {}),
    type: SERVER_RECORD_TYPE,
    data: detail,
    digest: `sha256:${sha256Hex(canonicalJsonBytes(detail))}`,
    extensions: {
      "ai.nimblebrain": {
        ...(iconUrl && isHttpUrl(iconUrl) ? { iconUrl } : {}),
        ...(category ? { category } : {}),
        servers: { [name]: { name: detail.name, auth: listing.install.auth } },
      },
    },
  };
}

/** The AI Catalog document over `servers`, in their order. */
export function aiCatalogFromServers(
  servers: readonly ServerDetail[],
  opts: ConvertOptions = {},
): Record<string, unknown> {
  const publisher = opts.publisher ?? "local";
  if (!PUBLISHER.test(publisher)) {
    throw new ConnectorListError([
      `publisher "${publisher}" must be lowercase letters, digits, dots and hyphens`,
    ]);
  }
  return {
    specVersion: LISTING_SPEC_VERSION,
    host: { displayName: opts.hostName ?? publisher, identifier: publisher },
    entries: servers.map((s) => bareConnectorEntry(s, publisher)),
  };
}

/**
 * Read the connector list at `path` (a file, or a directory of `*.yaml`,
 * `*.yml` and `*.json`, read in sorted order) and return its AI Catalog.
 * Throws `ConnectorListError` naming every entry the runtime would drop.
 */
export function convertConnectorList(
  path: string,
  opts: ConvertOptions = {},
): Record<string, unknown> {
  const problems = validateCatalog(path).map((d) => d.message);
  if (problems.length > 0) throw new ConnectorListError(problems);
  const { entries } = readCatalogEntries(path);
  return aiCatalogFromServers(
    entries.map((e) => e.detail),
    opts,
  );
}
