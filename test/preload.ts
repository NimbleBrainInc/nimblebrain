/**
 * Preloaded by `bun test` (bunfig.toml `[test]`). Tests never reach the network
 * for the plugin catalog: without this, every runtime a test boots would fetch
 * catalog.nimblebrain.ai for its connector list and connector skills. The
 * address refuses at once, so a runtime that is not given a fixture catalog
 * boots with an empty one. A test that serves a fixture catalog sets
 * `NB_PLUGIN_CATALOG_URL` itself and restores this value after
 * (`OFFLINE_PLUGIN_CATALOG_URL`). Spawned processes inherit it.
 */

import { OFFLINE_PLUGIN_CATALOG_URL } from "./helpers/plugin-catalog.ts";

process.env.NB_PLUGIN_CATALOG_URL = OFFLINE_PLUGIN_CATALOG_URL;
