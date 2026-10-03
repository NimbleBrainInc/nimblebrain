/**
 * Kernel tools that work with no workspace in the request.
 *
 * A tool that acts on the caller or on the org — the caller's preferences, the
 * org's users and model config, the list of workspaces — reads no workspace.
 * It declares so in its `_meta`, and `POST /v1/tools/call` (the identity-scoped
 * door) calls only tools that declare it, with no workspace in the request
 * context. The same tools stay callable through every workspace door, where the
 * workspace in the request goes unread.
 *
 * Only kernel sources are read for the mark (`Runtime.getKernelSource`). A
 * connector's tool can set the same key and it changes nothing: the door never
 * resolves a connector. A tool with both kinds of action (`manage_connectors`,
 * the skills tools) declares the mark and refuses, inside its own handler, each
 * action that needs a workspace when none is in the request.
 *
 * ADR-0043.
 */

/** The `_meta` key, in the host's reverse-DNS namespace. */
export const WORKSPACE_META_KEY = "ai.nimblebrain/workspace";

/** Spread into a kernel tool's `meta` to declare that it works with no workspace. */
export const WORKSPACE_OPTIONAL_META = { [WORKSPACE_META_KEY]: "optional" } as const;

/** True when a tool declares that it works with no workspace in the request. */
export function isWorkspaceOptional(tool: { meta?: Record<string, unknown> }): boolean {
  return tool.meta?.[WORKSPACE_META_KEY] === "optional";
}
