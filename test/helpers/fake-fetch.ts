/**
 * A fake `fetch` from a plain handler.
 *
 * Bun's `typeof fetch` also carries a static `preconnect`, which no code under
 * test calls. The helper supplies a no-op for it, so a fake satisfies the type
 * without a cast at every site. The same mismatch is bridged in `src/` where the
 * AI SDK takes a `fetch` (see `src/model/registry.ts`).
 */
export function fakeFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}
