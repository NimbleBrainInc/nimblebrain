import { join } from "node:path";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";

/**
 * Directory of representative connector catalog files used by tests
 * (one DCR, one static-auth, one Composio entry, split across files to
 * also exercise the catalog read directory aggregation). Tests point a
 * `bundled-static` registry's `url` here instead of at the shipped
 * catalog, so they stay decoupled from production curation — which
 * lives in deployments, not in this repo.
 */
export const CONNECTOR_FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "connectors");

/**
 * A pre-URL connector ref (`{ name }` or `{ path }`) as JSON.parse leaves a
 * legacy record on disk. ConnectorRef no longer admits these shapes; the
 * `"url" in ref` guards that tests feed them to exist for exactly those rows.
 */
export function legacyConnectorRef(shape: { name: string } | { path: string }): ConnectorRef {
  return shape as unknown as ConnectorRef;
}
