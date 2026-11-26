/**
 * A server's host metadata on its handshake: the `_meta["ai.nimblebrain/host"]`
 * block (`schemas/host/v1/host.schema.json`) a NimbleBrain host reads a
 * server's screen placements from, carried on the result of `initialize` and,
 * on the 2026-07-28 revision, of `server/discover`.
 *
 * The MCP TypeScript SDK builds both results in members it declares private
 * (`_oninitialize`, `_ondiscover`) and offers no hook to add `_meta` to them,
 * so {@link declareHostMeta} wraps those two members on one server instance.
 * Every handler the SDK installs for either method (its own, and the ones its
 * serving entries install per connection or request) calls them, so the block
 * rides every era and transport. The member names are the SDK's internals:
 * the helper throws when they are gone, and the plugins' handshake tests fail
 * on an SDK upgrade that renames them. This file imports no MCP library; it
 * reaches the instance structurally.
 */

/** Where a handshake result's `_meta` carries a server's host metadata. */
export const HOST_META_KEY = "ai.nimblebrain/host";

type Meta = Record<string, unknown>;

/** The two private SDK members the helper wraps. */
interface HandshakeMembers {
  _oninitialize(request: unknown): Promise<Meta & { _meta?: Meta }>;
  _ondiscover(): Meta & { _meta?: Meta };
}

function hasHandshakeMembers(server: object): server is HandshakeMembers {
  const s = server as Partial<Record<keyof HandshakeMembers, unknown>>;
  return typeof s._oninitialize === "function" && typeof s._ondiscover === "function";
}

/**
 * Carry `hostMeta` on the server's handshake results, under {@link HOST_META_KEY} in
 * `_meta`, beside whatever `_meta` the SDK puts there. Call it once per server instance,
 * before the server is connected.
 */
export function declareHostMeta(server: object, hostMeta: unknown): void {
  if (!hasHandshakeMembers(server)) {
    throw new Error(
      "declareHostMeta: the MCP SDK's Server has no _oninitialize/_ondiscover; the handshake helper needs updating for this SDK version",
    );
  }
  const initialize = server._oninitialize.bind(server);
  const discover = server._ondiscover.bind(server);
  server._oninitialize = async (request) => {
    const result = await initialize(request);
    return { ...result, _meta: { ...result._meta, [HOST_META_KEY]: hostMeta } };
  };
  server._ondiscover = () => {
    const result = discover();
    return { ...result, _meta: { ...result._meta, [HOST_META_KEY]: hostMeta } };
  };
}
