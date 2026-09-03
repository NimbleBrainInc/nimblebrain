/**
 * The URI schemes this runtime interprets, and the one place they are named.
 *
 * Two ways a capability's resource is reached, and the difference decides who
 * turns the capability on:
 *
 *   - **Recognition** — the runtime pattern-matches the scheme and acts on what
 *     it finds. That is what these three are. Publishing a matching resource is
 *     enough, which is safe precisely because none of them costs the runtime
 *     anything standing: a skill is read when it is wanted, a UI renders when
 *     the agent asks, an overlay is composed on the next turn.
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
 * neither half — and a declaration landing on one of these is refused, because
 * one resource cannot carry two meanings to the same reader.
 *
 * This list is the single home for that set. The `read_resource` tool
 * description renders it rather than restating it, and
 * `parseNotificationsDeclaration` refuses against it, so reserving a fourth
 * scheme is one edit here and both move with it.
 */

/** Schemes the runtime resolves by recognizing them. */
export const RESERVED_RESOURCE_SCHEMES = ["skill", "ui", "instructions"] as const;

/** The set, rendered for prose that has to list it (`` `skill://`, `ui://` `` …). */
export const RESERVED_RESOURCE_SCHEMES_PROSE = RESERVED_RESOURCE_SCHEMES.map(
  (scheme) => `\`${scheme}://\``,
).join(", ");

/**
 * Whether a URI sits in a scheme this runtime already interprets.
 *
 * Scheme comparison is case-insensitive: RFC 3986 defines schemes that way, so
 * `UI://x` addresses the same namespace as `ui://x` and refusing only the
 * lowercase spelling would be a check that reads as one.
 */
export function isReservedResourceScheme(uri: string): boolean {
  const scheme = uri.slice(0, uri.indexOf(":")).toLowerCase();
  return (RESERVED_RESOURCE_SCHEMES as readonly string[]).includes(scheme);
}
