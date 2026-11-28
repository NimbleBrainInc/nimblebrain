/**
 * Preloaded by `bun test` (bunfig.toml `[test]`). Tests never reach the network
 * for the default catalog: without this, every runtime a test boots with no
 * `catalogs` block would read catalog.nimblebrain.ai's listing. The address
 * refuses at once, so such a runtime lists nothing. A test that serves a
 * catalog names it in `catalogs`. Spawned processes inherit it.
 */

import { OFFLINE_PLUGIN_CATALOG_URL } from "./helpers/plugin-catalog.ts";

process.env.NB_PLUGIN_CATALOG_URL = OFFLINE_PLUGIN_CATALOG_URL;
