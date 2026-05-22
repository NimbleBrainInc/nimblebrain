/**
 * JSON-RPC method names for the host-resources extension. Namespaced
 * under `ai.nimblebrain/` per the MCP extension convention; bundles
 * dispatch to these via `ctx.session.send_request(...)` (Python) or
 * `server.request(...)` (TS) on the SDK side.
 *
 * Result schemas reuse the standard MCP `ReadResourceResult` and
 * `ListResourcesResult` verbatim — the namespace only swaps the method
 * name. This keeps the eventual Layer-3 upstream proposal mechanical
 * (rename method, no schema migration).
 */

export const HOST_RESOURCES_READ_METHOD = "ai.nimblebrain/resources/read" as const;
export const HOST_RESOURCES_LIST_METHOD = "ai.nimblebrain/resources/list" as const;
