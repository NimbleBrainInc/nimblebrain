import { FILE_URI_SCHEME } from "../files/uri.ts";
import { ARTIFACT_URI_SCHEME } from "../host-resources/artifacts/artifact-uri.ts";

/**
 * The URI schemes this runtime resolves itself, and the rule for reaching one.
 *
 * Two ways a capability's resource is reached, and the difference decides who
 * turns the capability on:
 *
 *   - **Recognition** — the runtime resolves the URI on its own, either by
 *     walking the workspace registry for a scheme its apps publish or by
 *     matching the scheme directly. Publishing a matching resource is enough,
 *     which is safe precisely because none of these costs the runtime anything
 *     standing: a skill is read when it is wanted, a UI renders when the agent
 *     asks, an overlay is composed on the next turn, an artifact or a file is
 *     fetched when a viewer opens it.
 *   - **Declaration** — the runtime reads a URI out of a server's manifest and
 *     treats it as an opaque string. Nothing undeclared is reached. That is how
 *     an outbox is reached, because an outbox costs a poll per
 *     `(workspace, connector)` for as long as the connector is installed. Under
 *     recognition, publishing the right-shaped URI would *be* the grant for that
 *     cost, and the rule that a server declares its shape while an operator
 *     grants its privileges would be undone by the addressing scheme alone.
 *
 * So a declared resource lives in the **server's own** namespace — by
 * convention the scheme matching its source name, though the runtime parses
 * neither half — and a declaration landing on a recognized scheme is refused,
 * because one resource cannot carry two meanings to the same reader.
 *
 * Two sets, because they answer different questions and do not coincide:
 * a set that governs a refusal has to be complete or the refusal is decorative,
 * while a set that renders prose has to match what the reader can actually
 * reach. `artifact://` and `files://` are host-resolved but unreachable through
 * `read_resource`, so they belong in the first and not the second.
 */

/**
 * Schemes `read_resource` resolves by walking the workspace registry.
 *
 * Their home is here because no single module owns one: each is published as
 * resources by whichever in-process app serves them.
 */
const APP_RESOURCE_SCHEMES = ["skill", "ui", "instructions"] as const;

/**
 * Every scheme the runtime resolves itself, and so the closed set a declared
 * outbox may not land on.
 *
 * Composed rather than restated: `artifact` and `files` are taken from the
 * modules that own them, each of which already validates its own scheme as the
 * single authority for it. Adding a sixth means either extending
 * {@link APP_RESOURCE_SCHEMES} or importing the constant its owner exports —
 * never a third spelling of a scheme that already has a home.
 */
export const RESERVED_RESOURCE_SCHEMES = [
  ...APP_RESOURCE_SCHEMES,
  ARTIFACT_URI_SCHEME,
  FILE_URI_SCHEME,
] as const;

/**
 * The `read_resource`-reachable set, rendered for that tool's description
 * (`` `skill://`, `ui://` `` …).
 *
 * Deliberately not the reserved set: `artifact://` is intercepted before source
 * routing and `files://` belongs to an identity source that is composed into no
 * workspace registry, so `read_resource` reaches neither and must not advertise
 * them.
 */
export const READ_RESOURCE_SCHEMES_PROSE = APP_RESOURCE_SCHEMES.map(
  (scheme) => `\`${scheme}://\``,
).join(", ");

/**
 * Whether a URI sits in a scheme this runtime already resolves.
 *
 * Scheme comparison is case-insensitive: RFC 3986 defines schemes that way, so
 * `UI://x` addresses the same namespace as `ui://x` and refusing only the
 * lowercase spelling would be a check that reads as one.
 */
export function isReservedResourceScheme(uri: string): boolean {
  const scheme = uri.slice(0, uri.indexOf(":")).toLowerCase();
  return (RESERVED_RESOURCE_SCHEMES as readonly string[]).includes(scheme);
}
