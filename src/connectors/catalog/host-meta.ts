import type { NotificationsDeclaration } from "../../notifications/types.ts";
import { RETIRED_ADMIN_TOOLS_KEY } from "../../permissions/admin-tools.ts";
import type { HostManifestMeta, PlacementDeclaration } from "../runtime/types.ts";
import { NIMBLEBRAIN_HOST_META_KEY, type ServerDetail } from "./server-detail.ts";

/**
 * The `ai.nimblebrain/host` block as the runtime reads it. Every field is
 * camelCase, and camelCase is the only spelling read.
 *
 * The snake_case keys (`host_version`, `record_arguments`, and a hook's
 * `register_tool` / `header_renames`) are not read: a block that carries only
 * the snake key behaves as if the field were absent. One is a permanent
 * exception, because ignoring it would widen access: a block that contains
 * `admin_tools` at all, whatever its value and whether or not `adminTools` is
 * also there, gates every tool on the server ({@link RETIRED_ADMIN_TOOLS_KEY}).
 *
 * Nothing else in the runtime reads the raw block. It lives beside
 * `server-detail.ts` rather than in it because that module is emitted to the
 * web tree as types (`scripts/codegen-web-platform-schemas.ts`) and must import
 * no runtime code.
 */

/** The entry's host block, the one read of the raw block. */
export function getNimbleBrainHostMeta(s: ServerDetail): HostManifestMeta | undefined {
  return normalizeHostMeta(s._meta?.[NIMBLEBRAIN_HOST_META_KEY]);
}

/**
 * The snake_case keys the host does not read, top-level ones by name and a
 * hook's as `hooks[].<key>`. The catalog gate refuses an entry that carries
 * one (`validateCatalog`), since the runtime would ignore it, or for
 * `admin_tools`, gate every tool.
 */
export const RETIRED_HOST_KEYS: readonly string[] = [
  "host_version",
  "admin_tools",
  "record_arguments",
];
export const RETIRED_HOOK_KEYS: readonly string[] = ["register_tool", "header_renames"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a host block into `HostManifestMeta`, or `undefined` when the entry
 * carries none (or carries one that is not an object, which
 * {@link hostBlockViolation} drops).
 *
 * The result is still unchecked below the top level: `placements`, `hooks`,
 * `notifications` and `adminTools` are re-derived from `unknown` by their own
 * parsers, which is where a malformed value is dropped or, for `adminTools`,
 * gates every tool. Each field is decided on whether its key is PRESENT, never
 * on whether its value is truthy.
 */
export function normalizeHostMeta(raw: unknown): HostManifestMeta | undefined {
  if (!isRecord(raw)) return undefined;
  const out: HostManifestMeta = { hostVersion: raw.hostVersion as string };
  if (Object.hasOwn(raw, "placements")) {
    out.placements = raw.placements as PlacementDeclaration[];
  }
  if (Object.hasOwn(raw, "notifications")) {
    out.notifications = raw.notifications as NotificationsDeclaration;
  }
  if (Object.hasOwn(raw, "hooks")) out.hooks = raw.hooks as HostManifestMeta["hooks"];
  if (Object.hasOwn(raw, "admin_tools")) {
    out.adminTools = RETIRED_ADMIN_TOOLS_KEY as string[];
  } else if (Object.hasOwn(raw, "adminTools")) {
    out.adminTools = raw.adminTools as string[];
  }
  if (Object.hasOwn(raw, "recordArguments")) {
    out.recordArguments = raw.recordArguments === true;
  }
  return out;
}

/**
 * Whether this runtime can read a host block of this `hostVersion`. Only the
 * major is a contract: blocks are added under major 1 without a bump and are
 * enabled by being present. A different major is a contract this runtime
 * predates, and it would otherwise parse that block as major 1 and ignore what
 * it does not know, so the entry is dropped: it cannot be installed.
 */
function isSupportedHostVersion(v: unknown): boolean {
  return typeof v === "string" && /^1(\.\d+)?$/.test(v);
}

/**
 * Why an entry's host block makes it unreadable, or `null` when it does not.
 * No block (absent or `null`) is fine. A block must be an object with a
 * `hostVersion` of major 1.
 */
export function hostBlockViolation(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return `the ai.nimblebrain/host block is not an object`;
  if (isSupportedHostVersion(raw.hostVersion)) return null;
  return `hostVersion must be major 1 ("1.0"): ${JSON.stringify(raw.hostVersion)}`;
}

/** The retired snake_case keys a host block carries; empty for a camelCase block (or none). */
export function retiredHostKeys(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const keys = RETIRED_HOST_KEYS.filter((k) => Object.hasOwn(raw, k));
  const hooks = Array.isArray(raw.hooks) ? raw.hooks.filter(isRecord) : [];
  for (const snake of RETIRED_HOOK_KEYS) {
    if (hooks.some((h) => Object.hasOwn(h, snake))) keys.push(`hooks[].${snake}`);
  }
  return keys;
}
