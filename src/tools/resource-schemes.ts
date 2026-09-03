import { FILE_URI_SCHEME } from "../files/uri.ts";
import { ARTIFACT_URI_SCHEME } from "../host-resources/artifacts/artifact-uri.ts";

/**
 * The URI schemes this runtime resolves itself, and the rule for reaching one.
 *
 * Two ways a capability's resource is reached, and the difference decides who
 * turns the capability on:
 *
 *   - **Recognition** — the runtime resolves the URI on its own: by walking the
 *     workspace registry for a scheme its apps publish, by matching the scheme
 *     directly, or by reading a fixed URI off every source. Publishing a
 *     matching resource is enough, which is safe because none of these buys the
 *     publisher anything it could not already have: a skill is read when it is
 *     wanted, a UI renders when the agent asks, an overlay is composed on the
 *     next turn, an artifact or a file is fetched when a viewer opens it, and
 *     `app://instructions` only ever adds the publisher's own text to the
 *     publisher's own entry in the prompt.
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
 * reach. `artifact://`, `files://` and `app://` are host-resolved but are not
 * things to point `read_resource` at, so they belong in the first and not the
 * second.
 *
 * Completeness is the property the refusal rests on, and a comment cannot hold
 * it: `scripts/check-resource-schemes.ts` fails the build on a scheme spelled
 * anywhere in `src/` that is in neither this set nor its explicit
 * not-host-resolved allowlist. Adding a scheme is therefore a decision the
 * build makes you record, in one of two places.
 */

/**
 * Schemes `read_resource` resolves by walking the workspace registry.
 *
 * Their home is here because no single module owns one: each is published as
 * resources by whichever in-process app serves them.
 */
const REGISTRY_RESOURCE_SCHEMES = ["skill", "ui", "instructions"] as const;

/**
 * The `app://` scheme, and the single URI under it the runtime reads.
 *
 * `app://instructions` is a host convention rather than a bundle's own
 * namespace, which is why it is named here and not by a subsystem: a bundle
 * publishes its custom-instructions overlay at that exact URI and
 * `Runtime.buildAppInfo` reads it off every bundle's source on every prompt
 * assembly. A fixed scheme is the point — a bundle author cannot be expected to
 * know the platform's server-name derivation, so the convention carries the
 * name instead.
 *
 * It is the one recognized scheme that costs a read per bundle per assembly, so
 * an outbox landing on it would be polled *and* rendered into the system
 * prompt.
 */
const APP_URI_SCHEME = "app";
export const APP_INSTRUCTIONS_URI = `${APP_URI_SCHEME}://instructions`;

/**
 * Every scheme the runtime resolves itself, and so the closed set a declared
 * outbox may not land on.
 *
 * Composed rather than restated: `artifact` and `files` are taken from the
 * modules that own them, each of which already validates its own scheme as the
 * single authority for it. Adding a seventh means extending
 * {@link REGISTRY_RESOURCE_SCHEMES}, importing the constant its owner exports, or —
 * when the scheme has no owner but this module — declaring it here as `app` is
 * declared. Never a second spelling of a scheme that already has a home.
 */
export const RESERVED_RESOURCE_SCHEMES = [
  ...REGISTRY_RESOURCE_SCHEMES,
  ARTIFACT_URI_SCHEME,
  FILE_URI_SCHEME,
  APP_URI_SCHEME,
] as const;

/**
 * The `read_resource`-reachable set, rendered for that tool's description
 * (`` `skill://`, `ui://` `` …).
 *
 * Deliberately not the reserved set. `artifact://` is intercepted before source
 * routing and `files://` belongs to an identity source composed into no
 * workspace registry, so `read_resource` reaches neither. `app://instructions`
 * it would reach — by asking each source in turn until one answers — but the
 * answer is whichever bundle replies first, which is not an address worth
 * handing the model.
 */
export const READ_RESOURCE_SCHEMES_PROSE = REGISTRY_RESOURCE_SCHEMES.map(
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
  // A URI with no colon carries no scheme and so sits in none of them. Guarded
  // explicitly because `indexOf` returns -1 and `slice(0, -1)` would drop the
  // last character instead of yielding nothing, making `skills` answer for
  // `skill`.
  const colon = uri.indexOf(":");
  if (colon < 0) return false;
  const scheme = uri.slice(0, colon).toLowerCase();
  return (RESERVED_RESOURCE_SCHEMES as readonly string[]).includes(scheme);
}
