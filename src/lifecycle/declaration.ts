import { summarizeToolNames } from "../tools/connector-surface.ts";
import type { Tool } from "../tools/types.ts";
import { LIFECYCLE_EVENTS, type LifecycleBinding, type LifecycleEvent } from "./types.ts";

/**
 * Checking a connection's lifecycle binding against the tools its server
 * advertises: {@link verifyLifecycleTools} asks "can the runtime ever
 * successfully call what this names?" The binding itself is read off the wire
 * (`src/services/lifecycle-extension.ts`).
 */

export class LifecycleContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleContractError";
  }
}

/**
 * Check every bound handler against the server's advertised tool list — that it
 * exists, that it accepts a call with no *required* arguments, and that it is
 * not task-required.
 *
 * This is `verifyRegisterTool`'s shape with a weaker predicate. The runtime
 * sends `on_ready` a `reason` only when the handler's schema declares it, so a
 * handler that takes nothing is the common case and must pass.
 *
 * `tools` must be the source's POPULATED list. Every name is absent from an
 * empty one, so calling this with an empty list would report a correct binding
 * as a contract violation — the caller separates the two.
 */
export function verifyLifecycleTools(
  tools: Tool[],
  decl: LifecycleBinding,
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
  // A lifecycle call is AWAITED by an operation the user is waiting on — the
  // uninstall waits behind `on_removing`, and the install behind `on_ready` —
  // so it has to be an operation the runtime can bound. Every lifecycle call is
  // made inline (the lifecycle port), never task-augmented, so a handler that
  // REQUIRES a task can never be called. "optional" is admitted: the inline
  // call is one the server accepts. The binding already refuses "required";
  // this holds the same line for the listing `notifyReady` reads.
  const taskSupport = tool.execution?.taskSupport;
  if (taskSupport === "required") {
    throw new LifecycleContractError(
      `Connector "${connector}" declares lifecycle "${event}" as "${toolName}", which advertises ` +
        `execution.taskSupport "${taskSupport}". A lifecycle handler must be an ordinary inline ` +
        `tool: the runtime awaits it while an install or an uninstall waits behind it, and a ` +
        `task-augmented call has no deadline it can be bounded by.`,
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
