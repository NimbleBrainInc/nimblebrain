/**
 * Built asset URL for each family in `bridge/fonts.ts`'s `FONT_SPECS`.
 *
 * Separate from `bridge/fonts.ts` on purpose: that module is reachable from the
 * shared bridge protocol, which the ROOT unit suite exercises with no `web/`
 * dependencies installed, so a `?url` import there breaks `Unit Tests (root deps
 * only)`. The specs stay there as plain data; the hashed URLs live here, in
 * `web/`, where the font packages resolve.
 *
 * Separate from `main.tsx` so it can be imported without running the entry's
 * side effects (Sentry init, `createRoot`) — which is what lets a test assert
 * every spec has a URL instead of grepping the entry's source text.
 */

import hankenGroteskUrl from "@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2?url";
import jetbrainsMonoUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";

/** family (as the palette names it) → hashed asset URL. */
export const FONT_URLS: Readonly<Record<string, string>> = {
  "Hanken Grotesk": hankenGroteskUrl,
  "JetBrains Mono Variable": jetbrainsMonoUrl,
};
