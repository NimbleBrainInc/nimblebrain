import { join } from "node:path";

/**
 * Directory of representative connector catalog files used by tests
 * (one DCR, one static-auth, one Composio entry, split across files to
 * also exercise `StaticSource` directory aggregation). Tests point a
 * `bundled-static` registry's `url` here instead of at the shipped
 * catalog, so they stay decoupled from production curation — which
 * lives in deployments, not in this repo.
 */
export const CONNECTOR_FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "connectors");
