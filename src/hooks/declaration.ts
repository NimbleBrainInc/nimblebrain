import type { HostManifestMeta } from "../bundles/types.ts";
import { HOOK_SLUG_RE } from "./token.ts";
import type { HookDeclaration } from "./types.ts";

/**
 * Reading and checking the `hooks` block a server declares in
 * `_meta["ai.nimblebrain/host"]`.
 *
 * Two checks live here and they answer different questions. `parseHookDeclarations`
 * asks "is this block well-formed?" and drops what isn't, matching how the host
 * treats every other field in this extension — an unknown or malformed
 * placement drops that placement, never the whole manifest. `isForwardablePath`
 * asks "can this route be forwarded to safely?" and is re-run at delivery time
 * as well, because by then the route has been through persistence and is an
 * untrusted input again.
 */

/**
 * Extract well-formed hook declarations, dropping malformed entries.
 *
 * A dropped entry means the stream is simply not offered — no URL is minted for
 * it and no delivery can reach it. That is the same tolerance the host extension
 * documents for placements, and it is the right default for a field a server
 * author is adding for the first time: a typo costs one stream, not the install.
 *
 * What is NOT tolerated is a well-formed declaration whose `register_tool` is
 * missing or mis-shaped — that check is `verifyRegisterTool` and it refuses the
 * install, because a stream the runtime will happily mint a URL for but can
 * never hand that URL to is a failure that only surfaces months later at a
 * vendor nobody is watching.
 */
export function parseHookDeclarations(meta: HostManifestMeta | undefined): HookDeclaration[] {
  // `meta` is an unchecked cast over manifest / registry JSON, so the declared
  // `HookDeclaration[]` type is a claim about intent, not a guarantee about
  // bytes. Everything below re-derives the shape from `unknown`.
  const raw = meta?.hooks as unknown;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: HookDeclaration[] = [];
  for (const entry of raw) {
    const decl = parseOneDeclaration(entry);
    // One declaration per vendor. A duplicate would mint two URLs for one
    // `(workspace, connector, vendor)` and the second would silently retire the
    // first as it rotated over the same registration record.
    if (!decl || seen.has(decl.vendor)) continue;
    seen.add(decl.vendor);
    out.push(decl);
  }
  return out;
}

/** One entry, or `null` when it is not well-formed enough to mint a URL for. */
function parseOneDeclaration(entry: unknown): HookDeclaration | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.vendor !== "string" || !HOOK_SLUG_RE.test(e.vendor)) return null;
  if (typeof e.register_tool !== "string" || e.register_tool.length === 0) return null;
  if (typeof e.route !== "string" || !isForwardablePath(e.route)) return null;
  const decl: HookDeclaration = {
    vendor: e.vendor,
    route: e.route,
    register_tool: e.register_tool,
  };
  if (typeof e.description === "string") decl.description = e.description;
  const renames = parseHeaderRenames(e.header_renames);
  if (renames) decl.header_renames = renames;
  return decl;
}

/** Header names must be RFC 7230 tokens; anything else could smuggle a second
 *  header or a body across the forward. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

function parseHeaderRenames(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
    if (!HEADER_NAME_RE.test(from)) continue;
    if (typeof to !== "string" || !HEADER_NAME_RE.test(to)) continue;
    // A rename INTO the stripped class would re-open the hole the strip exists
    // to close, letting a caller land a value on an identity header name.
    if (STRIPPED_REQUEST_HEADERS.has(to.toLowerCase())) continue;
    out[from.toLowerCase()] = to.toLowerCase();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Headers never forwarded from an inbound delivery.
 *
 * The identity half mirrors the fleet edge's own request-header strip list: a
 * delivery is an anonymous request and must not be able to assert who it is, on
 * this hop any more than on the edge's. The hop half (`host`, `connection`,
 * `transfer-encoding`, ...) is dropped because it describes the connection the
 * runtime terminated, not the one it is opening.
 *
 * `x-nb-hook-kid` is on the list even though the runtime is about to set it
 * from the token: an informational header that is not stripped is an identity
 * header waiting to happen, which is the hole the edge's `x-user-id` entry
 * already documents.
 */
export const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "x-tenant-id",
  "x-workspace-id",
  "x-subject-token",
  "x-user-id",
  "x-nb-hook-kid",
  "traceparent",
  "tracestate",
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
]);

/**
 * Whether a path contains a character that has no business in one: any control
 * character, a space, or DEL. Written as a scan rather than a regex because a
 * literal control-character class in a regex is itself a lint error, and the
 * escape-sequence form is harder to read than the predicate it stands for.
 */
function hasUnsafePathChars(route: string): boolean {
  for (let i = 0; i < route.length; i++) {
    const code = route.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether a declared route is a path this runtime may forward to.
 *
 * The route is resolved against the connector's own base URL, and `new URL()`
 * is generous in ways that matter here: `//evil.test/x` is a protocol-relative
 * URL that resolves to a DIFFERENT ORIGIN, and the forward carries a freshly
 * minted `aud=mcp-fleet` token — so a route that escapes the connector's origin
 * is server-side request forgery with a platform credential attached. One
 * character of validation closes the whole class, and `resolveForwardUrl`
 * re-asserts the resolved origin afterwards so nothing rests on this check
 * alone.
 */
export function isForwardablePath(route: string): boolean {
  if (typeof route !== "string") return false;
  if (route.length === 0 || route.length > 512) return false;
  if (!route.startsWith("/")) return false;
  // Protocol-relative (`//host/...`) and the backslash variants URL parsers
  // treat as authority separators.
  if (route.startsWith("//") || route.includes("\\")) return false;
  if (route.includes("..")) return false;
  // No fragment. A query is allowed — a vendor route may legitimately carry
  // one — but it must not smuggle a second URL.
  if (route.includes("#")) return false;
  if (hasUnsafePathChars(route)) return false;
  return true;
}

/** Throwing form of {@link isForwardablePath}, for the install path where the
 *  operator should see which route was refused. */
export function assertForwardablePath(route: string, context: string): void {
  if (!isForwardablePath(route)) {
    throw new Error(
      `[hooks] ${context}: route "${route}" is not a forwardable absolute path on the server`,
    );
  }
}

/**
 * Resolve a declared route against a connector's base URL, refusing anything
 * that leaves that origin.
 *
 * Belt and braces on top of `isForwardablePath`, and deliberately so: by
 * delivery time the route has been through the workspace record on disk, which
 * makes it an untrusted input to the kernel again regardless of what was
 * validated at install. Comparing the resolved origin is total — it does not
 * depend on having enumerated the tricks.
 */
export function resolveForwardUrl(baseUrl: string, route: string): URL {
  const base = new URL(baseUrl);
  if (!isForwardablePath(route)) {
    throw new Error(`[hooks] route "${route}" is not a forwardable absolute path`);
  }
  const target = new URL(route, base);
  if (target.origin !== base.origin) {
    throw new Error(
      `[hooks] route "${route}" resolves off the connector's origin (${target.origin} != ${base.origin})`,
    );
  }
  return target;
}
