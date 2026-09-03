import type { HostManifestMeta } from "../bundles/types.ts";
import { log } from "../observability/log.ts";
import { isReservedResourceScheme } from "../tools/resource-schemes.ts";
import type { NotificationsDeclaration } from "./types.ts";

/**
 * Reading the `notifications` block a server declares in
 * `_meta["ai.nimblebrain/host"]`.
 *
 * Same tolerance as `parseHookDeclarations`: the block is re-derived from
 * `unknown`, and a malformed one is dropped rather than failing the install.
 * A dropped declaration means the outbox is simply not offered — nothing is
 * polled and no notification can arrive from that connector.
 *
 * What is NOT the same is the consequence of admitting one. A hook declaration
 * decides where this runtime sends a delivery with a platform token attached,
 * which is why it is read only from operator-published metadata. An outbox
 * declaration grants no privilege at all: no mint, no new audience, no path to
 * a human. It buys a poll the runtime paces and content that lands in an inbox
 * nobody is obliged to read. See {@link NotificationsDeclaration}.
 */

/** Longest resource URI admitted. */
const RESOURCE_MAX = 512;

/** A URI with a scheme — `acme://notifications`, `https://…`. */
const URI_WITH_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/;

/**
 * Extract the outbox declaration, or `undefined` when there is none or it is
 * not well-formed.
 */
export function parseNotificationsDeclaration(
  meta: HostManifestMeta | undefined,
): NotificationsDeclaration | undefined {
  // `meta` is an unchecked cast over manifest / registry JSON, so the declared
  // type is a claim about intent. Re-derive the shape from `unknown`.
  const raw = meta?.notifications as unknown;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return dropDeclaration("notifications is not an object");
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.resource !== "string" || !isOutboxResource(entry.resource)) {
    return dropDeclaration(`resource ${JSON.stringify(entry.resource)} is not an outbox URI`);
  }
  if (isReservedResourceScheme(entry.resource)) {
    return dropReservedScheme(entry.resource);
  }
  const decl: NotificationsDeclaration = { resource: entry.resource };
  if (typeof entry.description === "string") decl.description = entry.description;
  return decl;
}

/**
 * Whether a declared outbox URI is one the runtime can read.
 *
 * It must carry a scheme, because a bare path names nothing a `resources/read`
 * can address. It must carry no query string and no fragment, because the
 * runtime reads it as the RFC 6570 template `<resource>{?cursor,maxEvents,maxAgeMs}`
 * and appends those parameters itself — a server-supplied `?` would either be
 * overwritten or produce two query strings, and neither failure is visible at
 * the point the declaration is written.
 */
export function isOutboxResource(resource: string): boolean {
  if (resource.length === 0 || resource.length > RESOURCE_MAX) return false;
  if (!URI_WITH_SCHEME_RE.test(resource)) return false;
  if (resource.includes("?") || resource.includes("#")) return false;
  return true;
}

function dropDeclaration(reason: string): undefined {
  log.debug("notify", `[notifications] dropping malformed declaration: ${reason}`);
  return undefined;
}

/**
 * Refuse an outbox declared in a scheme this runtime already interprets.
 *
 * A single resource cannot mean two things to the same reader: the runtime
 * would poll `ui://acme/notifications` as an outbox *and* resolve it as an app
 * surface, and whichever won would be an accident of ordering. The server's own
 * namespace is where an outbox belongs, and the closed set of schemes the
 * runtime resolves itself is assembled in one place
 * (`tools/resource-schemes.ts`), from the modules that own each one.
 *
 * Louder than a malformed block, deliberately. A malformed declaration is a
 * server that is visibly broken; this one is a server that looks entirely
 * correct and will simply never be polled, which is the failure that costs days
 * before anyone thinks to check. The connector is unaffected — its tools serve
 * as they did, and only the outbox is declined.
 */
function dropReservedScheme(resource: string): undefined {
  log.warn(
    `[notifications] refusing outbox ${JSON.stringify(resource)}: its scheme is one this ` +
      "runtime already interprets. Declare the outbox in the server's own namespace.",
  );
  return undefined;
}
