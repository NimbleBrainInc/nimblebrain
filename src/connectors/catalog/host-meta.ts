import type { NotificationsDeclaration } from "../../notifications/types.ts";
import { log } from "../../observability/log.ts";
import { adminToolsMalformedReason } from "../../permissions/admin-tools.ts";
import type { HostManifestMeta, PlacementDeclaration } from "../runtime/types.ts";
import { NIMBLEBRAIN_HOST_META_KEY, type ServerDetail } from "./server-detail.ts";

/**
 * The `ai.nimblebrain/host` block as the runtime reads it: every field
 * camelCase, whichever spelling the catalog entry used.
 *
 * The snake spelling (`host_version`, `admin_tools`, `record_arguments`, and a
 * hook's `register_tool` / `header_renames`) is read until every producer
 * writes camel, and each entry that uses it is logged once per process. Every
 * rule that reconciles two copies of one field fails closed, and each decides
 * on whether a key is PRESENT, never on whether its value is truthy, so a
 * `null` or `false` copy still counts:
 *
 * - `adminTools`: declared when either copy is present. Two well-formed copies
 *   gate their union (a second copy can only narrow); a malformed copy is
 *   passed on as the value, so the strict parse gates every tool. The union is
 *   the declaration, so the 64-name cap applies to it: a union over the cap
 *   gates every tool, as one list over it does.
 * - `recordArguments`: granted only when every present copy is `true`.
 * - `hostVersion`: present copies must be equal, and major 1, or the entry is
 *   dropped ({@link hostBlockViolation}).
 * - a hook's `registerTool` / `headerRenames`: either spelling; two copies that
 *   differ drop that hook, with a warning.
 *
 * Nothing else in the runtime reads the raw block, so nothing past this file
 * knows the snake spelling exists. It lives beside `server-detail.ts` rather
 * than in it because that module is emitted to the web tree as types
 * (`scripts/codegen-web-platform-schemas.ts`) and must import no runtime code.
 */

/** The entry's host block in camelCase, from either spelling. The one read of the raw block. */
export function getNimbleBrainHostMeta(s: ServerDetail): HostManifestMeta | undefined {
  return normalizeHostMeta(s._meta?.[NIMBLEBRAIN_HOST_META_KEY], s.name);
}

/** Each deprecated top-level key and the camel key it is read as. */
export const DEPRECATED_HOST_KEYS: Readonly<Record<string, string>> = {
  host_version: "hostVersion",
  admin_tools: "adminTools",
  record_arguments: "recordArguments",
};

/** Each deprecated key of a `hooks[]` entry and the camel key it is read as. */
export const DEPRECATED_HOOK_KEYS: Readonly<Record<string, string>> = {
  register_tool: "registerTool",
  header_renames: "headerRenames",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The copies of one field present on `o`, camel first. */
function copiesOf(o: Record<string, unknown>, camel: string, snake: string): unknown[] {
  const out: unknown[] = [];
  if (Object.hasOwn(o, camel)) out.push(o[camel]);
  if (Object.hasOwn(o, snake)) out.push(o[snake]);
  return out;
}

/**
 * Read a host block into camel `HostManifestMeta`, or `undefined` when the
 * entry carries none (or carries one that is not an object, which
 * {@link hostBlockViolation} drops).
 *
 * The result is still unchecked below the top level: `placements`, `hooks`,
 * `notifications` and `adminTools` are re-derived from `unknown` by their own
 * parsers, which is where a malformed value is dropped or, for `adminTools`,
 * gates every tool.
 */
export function normalizeHostMeta(raw: unknown, entry: string): HostManifestMeta | undefined {
  if (!isRecord(raw)) return undefined;
  warnDeprecatedKeys(entry, raw);
  const [hostVersion] = copiesOf(raw, "hostVersion", "host_version");
  const out: HostManifestMeta = { hostVersion: hostVersion as string };
  if (Object.hasOwn(raw, "placements")) {
    out.placements = raw.placements as PlacementDeclaration[];
  }
  if (Object.hasOwn(raw, "notifications")) {
    out.notifications = raw.notifications as NotificationsDeclaration;
  }
  if (Object.hasOwn(raw, "hooks")) out.hooks = normalizeHooks(raw.hooks, entry);
  const adminTools = copiesOf(raw, "adminTools", "admin_tools");
  if (adminTools.length > 0) out.adminTools = mergeAdminTools(adminTools);
  const recordArguments = copiesOf(raw, "recordArguments", "record_arguments");
  if (recordArguments.length > 0) {
    out.recordArguments = recordArguments.every((v) => v === true);
  }
  return out;
}

/**
 * One value for `adminTools` from its present copies. A malformed copy wins,
 * so the parse that follows gates every tool; otherwise the union, which no
 * name in either copy can be missing from.
 */
function mergeAdminTools(copies: unknown[]): string[] {
  for (const copy of copies) {
    if (adminToolsMalformedReason(copy) !== null) return copy as string[];
  }
  return [...new Set(copies.flatMap((c) => c as string[]))];
}

/**
 * Each hook entry with its fields in camel. An entry that is not an object is
 * kept as it is, for `parseHookDeclarations` to drop. An entry whose two
 * copies of one field differ is dropped here.
 */
function normalizeHooks(raw: unknown, entry: string): HostManifestMeta["hooks"] {
  if (!Array.isArray(raw)) return raw as HostManifestMeta["hooks"];
  const out: unknown[] = [];
  for (const hook of raw) {
    if (!isRecord(hook)) {
      out.push(hook);
      continue;
    }
    const normalized = normalizeHook(hook, entry);
    if (normalized) out.push(normalized);
  }
  return out as HostManifestMeta["hooks"];
}

function normalizeHook(
  hook: Record<string, unknown>,
  entry: string,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hook)) {
    if (!Object.hasOwn(DEPRECATED_HOOK_KEYS, key)) out[key] = value;
  }
  for (const [snake, camel] of Object.entries(DEPRECATED_HOOK_KEYS)) {
    const copies = copiesOf(hook, camel, snake);
    if (copies.length === 0) continue;
    if (copies.length === 2 && !sameValue(copies[0], copies[1])) {
      warnOnce(
        `${entry}\0hook\0${String(hook.vendor)}\0${camel}`,
        `[catalog] entry "${entry}": hook ${JSON.stringify(hook.vendor)} declares ${camel} and ${snake} with different values; the hook is dropped until one is removed`,
      );
      return null;
    }
    out[camel] = copies[0];
  }
  return out;
}

/** Structural equality over JSON values, ignoring key order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
    );
  }
  return false;
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
 * `hostVersion` (or `host_version`) of major 1; when both are present they
 * must be equal, since two versions of one contract is no version.
 */
export function hostBlockViolation(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return `the ai.nimblebrain/host block is not an object`;
  const copies = copiesOf(raw, "hostVersion", "host_version");
  if (copies.length === 2 && copies[0] !== copies[1]) {
    return `hostVersion ${JSON.stringify(copies[0])} and host_version ${JSON.stringify(copies[1])} disagree`;
  }
  if (isSupportedHostVersion(copies[0])) return null;
  return `hostVersion must be major 1 ("1.0"): ${JSON.stringify(copies[0])}`;
}

/**
 * The deprecated keys a host block uses, top-level ones by name and a hook's as
 * `hooks[].<key>`. Empty when the block is camel (or absent).
 */
export function deprecatedHostKeys(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const keys = Object.keys(DEPRECATED_HOST_KEYS).filter((k) => Object.hasOwn(raw, k));
  const hooks = Array.isArray(raw.hooks) ? raw.hooks.filter(isRecord) : [];
  for (const snake of Object.keys(DEPRECATED_HOOK_KEYS)) {
    if (hooks.some((h) => Object.hasOwn(h, snake))) keys.push(`hooks[].${snake}`);
  }
  return keys;
}

function warnDeprecatedKeys(entry: string, raw: Record<string, unknown>): void {
  const keys = deprecatedHostKeys(raw);
  if (keys.length === 0) return;
  warnOnce(
    `${entry}\0deprecated\0${keys.join(",")}`,
    `[catalog] entry "${entry}": deprecated host key ${keys.join(", ")}; write the camelCase spelling`,
  );
}

/** The block is normalized on every catalog read, which a member's every call
 *  makes, so each distinct warning is logged once per process. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message);
}
