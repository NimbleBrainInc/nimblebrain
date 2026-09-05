/**
 * The coordinates a Smithery session mints, and how to read them back off a
 * brokered ref's opaque `providerRef`.
 *
 * Its own module because two arms need the same read and must not drift: the
 * `cleanup` arm (`provider.ts`) and the liveness probe (`connection-probe.ts`).
 * They cannot import each other — `provider.ts` constructs the probe — so a
 * shared home is what keeps a fourth coordinate from being added to one and
 * silently skipped by the other.
 */

/** What a DELETE or a status read must name: the connection, and where it lives. */
export interface SmitheryCoordinates {
  connectionId: string;
  namespace: string;
  baseUrl: string;
}

/**
 * Read the coordinates out of a brokered ref's `providerRef`.
 *
 * Host and namespace come from the REF, never from current config: the ref's
 * session URL bakes both in at install and keeps working if an operator later
 * repoints them, so a config-reading caller would act on the wrong namespace —
 * where a 404 reads as "already gone" and reports success while the real
 * connection survives.
 *
 * `createSession` never returns a partial set and the install refuses a blank
 * coordinate, so an incomplete ref was written by something else: `undefined`,
 * and the caller declines to act rather than guessing.
 */
export function smitheryCoordinatesFrom(
  providerRef: Record<string, string> | undefined,
): SmitheryCoordinates | undefined {
  const connectionId = providerRef?.connectionId;
  const namespace = providerRef?.namespace;
  const baseUrl = providerRef?.baseUrl;
  if (!connectionId || !namespace || !baseUrl) return undefined;
  return { connectionId, namespace, baseUrl };
}
