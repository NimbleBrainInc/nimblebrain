import type { HostManifestMeta } from "../connectors/runtime/types.ts";
import { log } from "../observability/log.ts";
import { summarizeToolNames } from "../tools/connector-surface.ts";
import type { Tool } from "../tools/types.ts";
import { LIFECYCLE_EVENTS, type LifecycleDeclaration, type LifecycleEvent } from "./types.ts";

/**
 * Reading and checking the `lifecycle` block a server declares in
 * `_meta["ai.nimblebrain/host"]`.
 *
 * Two checks live here and they answer different questions, the same split
 * `src/hooks/declaration.ts` makes. {@link parseLifecycleDeclaration} asks "is
 * this block well-formed?" and drops what isn't, matching how the host treats
 * every other field in this extension — a malformed entry costs that entry,
 * never the install. {@link verifyLifecycleTools} asks "can the runtime ever
 * successfully call what this names?" and needs the server's advertised tool
 * list to answer.
 */

/** Longest tool name admitted. A name is an identifier, not a payload. */
const TOOL_NAME_MAX = 128;

/**
 * Extract the lifecycle declaration, or `undefined` when there is none or
 * nothing in it is well-formed.
 *
 * One loop over {@link LIFECYCLE_EVENTS}, which is what keying the block by
 * event buys: a third event is a new entry in that list and no new branch here.
 */
export function parseLifecycleDeclaration(
  meta: HostManifestMeta | undefined,
): LifecycleDeclaration | undefined {
  // `meta` is an unchecked cast over manifest / registry JSON, so the declared
  // type is a claim about intent, not a guarantee about bytes. Re-derive the
  // shape from `unknown`.
  const raw = meta?.lifecycle as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) drop("lifecycle is not an object");
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const decl: LifecycleDeclaration = {};
  for (const event of LIFECYCLE_EVENTS) {
    const name = entry[event];
    if (name === undefined) continue;
    if (typeof name !== "string" || name.length === 0 || name.length > TOOL_NAME_MAX) {
      drop(`${event} is not a tool name`);
      continue;
    }
    decl[event] = name;
  }
  return Object.keys(decl).length > 0 ? decl : undefined;
}

function drop(reason: string): void {
  log.debug("lifecycle", `[lifecycle] dropping malformed declaration: ${reason}`);
}

export class LifecycleContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleContractError";
  }
}

/**
 * Check every declared handler against the server's advertised tool list — that
 * it exists, and that it accepts a call with no *required* arguments.
 *
 * This is `verifyRegisterTool`'s shape with a weaker predicate, and the
 * asymmetry is load-bearing. That check verifies `{vendor, url}` are accepted
 * because a `register_tool` that cannot receive them can never be handed
 * anything. Here the runtime sends `on_ready` a `reason` the schema **need not
 * mention**: `reason` is an optional refinement, and requiring it declared
 * would break every bundle that does not care about it — which is most of them.
 *
 * That rests on a dependency worth naming rather than leaving to be discovered:
 * **the server framework must accept and ignore unknown arguments.**
 * FastMCP/pydantic does. A server that errors on an undeclared argument would
 * fail every call, so the developer page states it as a requirement on the
 * handler. What is checked here is only the half the runtime can see — that a
 * call carrying no arguments at all would be accepted.
 *
 * `tools` must be the source's POPULATED list. Every name is absent from an
 * empty one, so calling this with an empty list would report a correct manifest
 * as a contract violation — the caller separates the two.
 */
export function verifyLifecycleTools(
  tools: Tool[],
  decl: LifecycleDeclaration,
  connector: string,
): void {
  for (const event of LIFECYCLE_EVENTS) {
    const toolName = decl[event];
    if (!toolName) continue;
    verifyOne(tools, event, toolName, connector);
  }
}

function verifyOne(
  tools: Tool[],
  event: LifecycleEvent,
  toolName: string,
  connector: string,
): void {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new LifecycleContractError(
      `Connector "${connector}" declares lifecycle "${event}" as "${toolName}", which is not ` +
        `among the ${tools.length} tools its server advertises (${summarizeToolNames(tools)}). ` +
        `A lifecycle handler the runtime cannot call is never called.`,
    );
  }
  // The runtime sends no arguments the handler is obliged to read, so a
  // required property is a call that can only ever fail. Read off the
  // advertised schema rather than off the properties: a server may declare
  // `reason` (or its own arguments) freely — what it may not do is oblige the
  // caller to supply one.
  const required = tool.inputSchema?.required;
  if (Array.isArray(required) && required.length > 0) {
    throw new LifecycleContractError(
      `Connector "${connector}" declares lifecycle "${event}" as "${toolName}", whose input ` +
        `schema requires ${summarizeRequired(required)}. ` +
        `The runtime calls a lifecycle handler with no required arguments.`,
    );
  }
}

/**
 * The required property names, bounded on both axes. They come off the wire, so
 * an unbounded join here is an unbounded error string — the same reason
 * `summarizeToolNames` is bounded.
 */
function summarizeRequired(required: unknown[]): string {
  const shown = required.slice(0, 8).map((r) => JSON.stringify(String(r).slice(0, 60)));
  const joined = shown.join(", ");
  return required.length > shown.length ? `${joined}, …` : joined;
}
