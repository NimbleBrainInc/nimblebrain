import { bindCatalogEntry } from "../connectors/catalog/binding.ts";
import type { ConnectorCatalogEntry } from "../connectors/catalog/types.ts";
import type { ConnectorRef } from "../connectors/runtime/types.ts";

/**
 * The catalog id identified telemetry names an installed connector by, or
 * `undefined` (sent as `custom`). The same binding that grants a catalog entry's
 * UI and credentials decides it, so a connector is named only when it IS the
 * entry's server: its URL matches after normalizing (case, default port, a
 * trailing slash), or a broker stamped it with the entry's id. A connector that
 * merely carries a catalog name is another server and stays `custom`.
 */
export function telemetryCatalogId(
  ref: ConnectorRef,
  entries: readonly ConnectorCatalogEntry[],
): string | undefined {
  const binding = bindCatalogEntry(ref, entries);
  return binding.kind === "bound" ? binding.entry.id : undefined;
}
