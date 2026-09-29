import type { AdminToolsDeclaration } from "../connectors/catalog/types.ts";
import type { HostManifestMeta } from "../connectors/runtime/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { HookDeclaration } from "../hooks/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { LIFECYCLE_EVENTS, type LifecycleDeclaration } from "../lifecycle/types.ts";
import { log } from "../observability/log.ts";
import { summarizeToolNames } from "../tools/connector-surface.ts";
import type { Tool } from "../tools/types.ts";
import { splitInnerToolName } from "../util/tool-name.ts";
import { canWriteWorkspaceScoped } from "../workspace/authz.ts";
import type { Workspace } from "../workspace/types.ts";

/**
 * Connector tools that need a workspace admin: the `admin_tools` list a server
 * declares in `_meta["ai.nimblebrain/host"]`.
 *
 * The role gate for connector tools. A fleet bundle is told the tenant and the
 * workspace that called it and never the person, so it cannot check a role
 * itself; the kernel holds membership, so the kernel refuses. The declaration
 * only ever REMOVES callers, which is why a server may make it about itself.
 *
 * It is read from the operator-trusted catalog entry, like `hooks`, and never
 * from anything the running server sends: a tool `_meta` annotation would
 * silently widen access back the moment a later build dropped it.
 *
 * Workspace admin means what `canWriteWorkspaceScoped` means: a member of the
 * bound workspace whose membership role is `admin`. An org admin who is not
 * that gets no bypass, and no identity is refused.
 */

/** Most names admitted. A connector with more admin tools than this is not
 *  describing a role boundary. */
const ADMIN_TOOLS_MAX = 64;

/** Longest name admitted, matching the lifecycle declaration's bound. */
const TOOL_NAME_MAX = 128;

/**
 * Parse the declared admin tools, or `undefined` when none are declared.
 *
 * Strict where the rest of the host extension is tolerant, because this field
 * only narrows: dropping a bad part of it would widen access. A present
 * declaration that is not a list of at most {@link ADMIN_TOOLS_MAX} bare tool
 * names (`null` included — a bare `admin_tools:` in YAML) gates EVERY tool on
 * the connector, with a warning naming it. An empty list declares nothing.
 * Duplicates collapse.
 */
export function parseAdminToolsDeclaration(
  meta: HostManifestMeta | undefined,
  connector: string,
): AdminToolsDeclaration | undefined {
  // `meta` is an unchecked cast over manifest / registry JSON, so the declared
  // type is a claim about intent, not a guarantee about bytes.
  const raw = meta?.admin_tools as unknown;
  if (raw === undefined) return undefined;
  const reason = malformedReason(raw);
  if (reason !== null) {
    warnOnce(connector, reason);
    return { kind: "all", reason };
  }
  const names = [...new Set(raw as string[])];
  return names.length > 0 ? { kind: "names", names } : undefined;
}

function malformedReason(raw: unknown): string | null {
  if (!Array.isArray(raw)) return "admin_tools is not a list";
  if (raw.length > ADMIN_TOOLS_MAX) return `admin_tools names more than ${ADMIN_TOOLS_MAX} tools`;
  if (!raw.every(isBareToolName)) return "admin_tools has an entry that is not a bare tool name";
  return null;
}

function isBareToolName(entry: unknown): entry is string {
  return (
    typeof entry === "string" &&
    entry.length > 0 &&
    entry.length <= TOOL_NAME_MAX &&
    !/\s/.test(entry)
  );
}

/** The projection reruns on every catalog read, which a non-admin's every call
 *  makes, so each connector's malformed declaration is logged once. */
const warned = new Set<string>();

function warnOnce(connector: string, reason: string): void {
  const key = `${connector}\0${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(
    `[admin-tools] connector "${connector}": ${reason}; every tool on it is admin-only until the declaration is fixed`,
  );
}

/**
 * Whether `identity` may call `toolName` on a connector that declares
 * `adminTools`, in workspace `ws`.
 *
 * Allowed when the tool is not declared (and the declaration is not `all`), or
 * when `canWriteWorkspaceScoped` allows. The one predicate behind both the
 * listing filter and the dispatch refusal, so a member's agent never lists a
 * tool it would be refused.
 */
export function isAdminToolAllowed(
  identity: Pick<UserIdentity, "id"> | null | undefined,
  ws: Workspace | null | undefined,
  adminTools: AdminToolsDeclaration | undefined,
  toolName: string,
): boolean {
  if (!gates(adminTools, toolName)) return true;
  return canWriteWorkspaceScoped(identity, ws).allowed;
}

function gates(adminTools: AdminToolsDeclaration | undefined, toolName: string): boolean {
  if (adminTools === undefined) return false;
  return adminTools.kind === "all" || adminTools.names.includes(toolName);
}

/**
 * The refusal every door returns, in the envelope `assertToolAllowed` uses.
 *
 * The text tells a person who can do this. It names no other route to the
 * tool, because there is none and a model reading it should not go looking.
 */
export function adminToolDenial(serverName: string, toolName: string): ToolResult {
  return {
    content: textContent(
      `Only a workspace admin can use "${serverName}__${toolName}". Ask a workspace admin to make this change.`,
    ),
    isError: true,
    structuredContent: {
      error: "workspace_admin_required",
      connector: serverName,
      tool: toolName,
    },
  };
}

/**
 * Install warnings for an `admin_tools` declaration, empty when there is
 * nothing to say. Never a reason to stop enforcing: every name is enforced
 * whether or not the server advertises it today.
 *
 * - A malformed declaration gates every tool; that is the one warning.
 * - A name the server does not advertise is probably a typo or a tool behind a
 *   flag; the gate holds for it anyway.
 * - A name that is also a lifecycle handler or a hooks `register_tool` is one
 *   the kernel calls itself. Those calls reach the source directly and are not
 *   checked, so the kernel's call still works, but the declaration mixes two
 *   contracts and is worth a look.
 *
 * `tools` is the source's advertised list, or `undefined` when the source is
 * not running yet; the unadvertised check is skipped then rather than
 * reporting every name as missing.
 */
export function adminToolsContractWarnings(opts: {
  connector: string;
  adminTools: AdminToolsDeclaration | undefined;
  lifecycle?: LifecycleDeclaration;
  hooks?: readonly HookDeclaration[];
  tools?: Tool[];
}): string[] {
  const { connector, tools } = opts;
  if (opts.adminTools?.kind === "all") {
    return [
      `Connector "${connector}": ${opts.adminTools.reason}, so every tool on it is refused to ` +
        `non-admins until the catalog entry's admin_tools is fixed.`,
    ];
  }
  const adminTools = opts.adminTools?.names;
  if (!adminTools || adminTools.length === 0) return [];
  const kernelCalled = kernelCalledTools(opts.lifecycle, opts.hooks);
  const warnings: string[] = [];
  for (const name of adminTools) {
    const role = kernelCalled.get(name);
    if (!role) continue;
    warnings.push(
      `Connector "${connector}" declares "${name}" in admin_tools and as its ${role}. ` +
        `The runtime's own call is not checked; a member calling it directly is refused.`,
    );
  }
  if (!tools || tools.length === 0) return warnings;
  const advertised = new Set(tools.map((t) => t.name));
  for (const name of adminTools) {
    if (advertised.has(name)) continue;
    warnings.push(
      `Connector "${connector}" declares "${name}" in admin_tools, which is not among the ` +
        `${tools.length} tools its server advertises (${summarizeToolNames(tools)}). ` +
        `It is refused to non-admins by name regardless.`,
    );
  }
  return warnings;
}

/** The tools the kernel itself calls on a connector, each with the role it
 *  plays, for the overlap warning. */
function kernelCalledTools(
  lifecycle: LifecycleDeclaration | undefined,
  hooks: readonly HookDeclaration[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of LIFECYCLE_EVENTS) {
    const name = lifecycle?.[event];
    if (name) out.set(name, `lifecycle "${event}"`);
  }
  for (const decl of hooks ?? []) {
    out.set(decl.register_tool, `hook "${decl.vendor}" register_tool`);
  }
  return out;
}

/**
 * One caller's admission to connector tools in one workspace, resolved once and
 * asked per tool. Listing filters with it and dispatch refuses with it, so the
 * two cannot disagree.
 */
export interface ConnectorAdmission {
  /** `serverName` is the connector's source name; `toolName` the bare tool. */
  admits(serverName: string, toolName: string): boolean;
}

/** The admission of a workspace admin, or of a workspace no connector gates. */
export const ADMIT_ALL: ConnectorAdmission = { admits: () => true };

/**
 * Drop the workspace tools `admission` refuses from a listing of bare
 * `<source>__<tool>` names. A name with no separator names no connector and
 * stays.
 */
export function filterAdmittedTools<T extends { name: string }>(
  tools: readonly T[],
  admission: ConnectorAdmission,
): T[] {
  if (admission === ADMIT_ALL) return [...tools];
  return tools.filter((t) => {
    const { sourcePrefix, bareToolName, hasSeparator } = splitInnerToolName(t.name);
    return !hasSeparator || admission.admits(sourcePrefix, bareToolName);
  });
}
