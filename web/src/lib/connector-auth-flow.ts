/**
 * Which connector auth kinds have an interactive sign-in the client can launch.
 *
 * A **brokered or platform-minted** connector carries its own credential: the
 * install eager-starts it `running` and there is nothing for the user to sign
 * in to. Calling the OAuth initiate endpoint for one is not merely useless — it
 * throws "already connected" on a running source and surfaces as a 500, so a
 * successful install reports as a red error.
 *
 * A named predicate with one call site, deliberately. It is not here to
 * de-duplicate — it is here to be *testable*: the condition it replaces lives
 * inside a component closure, so a regression could only be caught by rendering
 * the page, and the failure it guards is silent (a successful install reporting
 * a 500). As a module it gets a unit test that dies when a kind is dropped.
 * Inline it again and that coverage goes with it.
 */

/** Auth kinds whose credential is held by the platform or a broker, not the user. */
const NON_INTERACTIVE_AUTH: readonly string[] = ["provider", "smithery"];

/**
 * True when installing this kind should go straight to Configure instead of
 * launching an auth flow.
 */
export function installCompletesWithoutSignIn(auth: string): boolean {
  return NON_INTERACTIVE_AUTH.includes(auth);
}
