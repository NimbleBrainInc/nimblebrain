/**
 * The `ai.nimblebrain/lifecycle` MCP extension, host side.
 *
 * A server that advertises the extension in its capabilities marks one tool per
 * event with `_meta["ai.nimblebrain/lifecycle"]: { "event": "ready" | "removing" }`,
 * and the host calls that tool when it has made the server available to a
 * workspace (`ready`) and before it removes it (`removing`). The extension adds
 * no method. Public contract: `docs/src/content/docs/extensions/lifecycle.mdx`.
 *
 * This module holds the wire shape and the checks the extension requires of a
 * host. It does no I/O; `src/lifecycle/bindings.ts` snapshots a connection's
 * binding, and `src/lifecycle/notify.ts` delivers the events.
 */

import type { LifecycleBinding, LifecycleEvent, LifecycleReadyReason } from "../lifecycle/types.ts";
import type { Tool } from "../tools/types.ts";

/** Extension identifier, the key in `capabilities.extensions` and in a handler tool's `_meta`. */
export const LIFECYCLE_EXTENSION_ID = "ai.nimblebrain/lifecycle" as const;

/**
 * The client's declaration: the extension with an empty settings object, so a
 * server knows it will be told and may skip listing its handlers to a host that
 * will not call them.
 */
export function lifecycleClientExtension(): Record<string, Record<string, never>> {
  return { [LIFECYCLE_EXTENSION_ID]: {} };
}

/** Whether a server's advertised `extensions` map carries this extension. */
export function advertisesLifecycle(extensions: Record<string, unknown>): boolean {
  return LIFECYCLE_EXTENSION_ID in extensions;
}

/**
 * The wire event names, mapped to the kernel's event keys. A marker whose
 * `event` is not here is ignored, so a later version can add events without a
 * new identifier.
 */
const WIRE_EVENTS: Readonly<Record<string, LifecycleEvent>> = {
  ready: "on_ready",
  removing: "on_removing",
};

/** A marked tool, or an event, the host treats as undeclared, with why. */
export interface LifecycleRejection {
  /** The marked tool, or one of the conflicting tools for a duplicate. */
  tool: string;
  reason: string;
  /** The event the marker names, when it names a known one. */
  event?: LifecycleEvent;
}

/**
 * The `event → tool` binding of one connection, from its `tools/list`, with
 * what was rejected.
 *
 * The marker is the only signal: a handler is never identified by its name or
 * its description. Rejections, per the extension's contract:
 *  - two or more tools marked for one event: the event is undeclared, and no
 *    tool is chosen;
 *  - a marked tool whose `inputSchema` lists a `required` property, or whose
 *    `execution.taskSupport` is `"required"`: that tool is undeclared;
 *  - a marker whose `event` is unknown: ignored, and reported.
 *
 * `tools` must be named as the server names them (bare). The caller must have
 * checked that the server advertised the extension on this connection
 * ({@link advertisesLifecycle}); a marker from a server that did not is not a
 * handler.
 */
export function selectLifecycleHandlers(tools: readonly Tool[]): {
  binding: LifecycleBinding;
  rejected: LifecycleRejection[];
} {
  const marked = new Map<LifecycleEvent, Tool[]>();
  const rejected: LifecycleRejection[] = [];
  for (const tool of tools) {
    const event = markedEvent(tool);
    if (event === undefined) continue;
    if ("reason" in event) rejected.push(event);
    else marked.set(event.event, [...(marked.get(event.event) ?? []), tool]);
  }

  // Duplicates are counted before each tool is checked: two marked tools for
  // one event leave it undeclared even when only one of them is callable.
  const binding: LifecycleBinding = { declaredBy: "extension" };
  for (const [event, candidates] of marked) {
    const [only, ...others] = candidates;
    if (!only) continue;
    if (others.length > 0) {
      const names = candidates.map((t) => JSON.stringify(t.name.slice(0, 60))).join(", ");
      rejected.push({
        tool: only.name,
        event,
        reason: `${candidates.length} tools (${names}) are marked for "${wireName(event)}", so the event is undeclared`,
      });
      continue;
    }
    const why = uncallable(only);
    if (why) rejected.push({ tool: only.name, event, reason: why });
    else binding[event] = only.name;
  }
  return { binding, rejected };
}

/** The event a tool's marker names, a rejection for a marker that names none, or `undefined` for an unmarked tool. */
function markedEvent(tool: Tool): { event: LifecycleEvent } | LifecycleRejection | undefined {
  const marker = tool.meta?.[LIFECYCLE_EXTENSION_ID];
  if (marker === undefined) return undefined;
  if (!isRecord(marker)) {
    return { tool: tool.name, reason: "its lifecycle marker is not an object" };
  }
  const wire = marker.event;
  const event = typeof wire === "string" ? WIRE_EVENTS[wire] : undefined;
  if (event) return { event };
  return {
    tool: tool.name,
    reason: `its lifecycle marker names an unknown event ${JSON.stringify(String(wire).slice(0, 40))}, which is ignored`,
  };
}

/** Why a marked tool cannot be a handler, or `undefined` when it can. */
function uncallable(tool: Tool): string | undefined {
  const required = tool.inputSchema?.required;
  if (Array.isArray(required) && required.length > 0) {
    return "its input schema lists a required property, and a handler is called with none";
  }
  if (tool.execution?.taskSupport === "required") {
    return 'its execution.taskSupport is "required", and a lifecycle call is synchronous';
  }
  return undefined;
}

function wireName(event: LifecycleEvent): string {
  return Object.keys(WIRE_EVENTS).find((k) => WIRE_EVENTS[k] === event) ?? event;
}

/**
 * The arguments of a `ready` call to an extension-declared handler:
 * `{ reason }` when the handler's `inputSchema` declares a `reason` property,
 * and `{}` otherwise. Sending an argument the handler did not declare would rest
 * on the server's framework ignoring it, which the extension does not allow.
 */
export function readyArguments(
  tool: Pick<Tool, "inputSchema"> | undefined,
  reason: LifecycleReadyReason,
): Record<string, unknown> {
  const properties = tool?.inputSchema?.properties;
  return isRecord(properties) && "reason" in properties ? { reason } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
