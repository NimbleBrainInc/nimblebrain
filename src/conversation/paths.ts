/**
 * The single sanctioned construction (and parse) site for workspace-partitioned
 * conversation paths. Mirrors how `namespacedToolName` is the only site for
 * `ws_<id>-` tool names: every conversation directory is built and parsed here,
 * so the on-disk layout has exactly one definition.
 *
 * The workspace owns the directory: a conversation lives under the workspace it
 * runs in, with the owner as a privacy sub-partition. The path is the binding — `Conversation.workspaceId`
 * is a denormalised convenience, the directory is authoritative.
 *
 *   workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl          private user chats
 *   workspaces/<wsId>/conversations/_runs/<automationId>/<convId>.jsonl  automation runs (workspace-visible)
 *
 * This file is on the allow-list of `check:workspace-paths` (it defines the
 * `workspaces/<wsId>/...` conversation layout) and is the only site
 * `check:conversation-paths` permits.
 */

import { join, sep } from "node:path";

/** Reserved owner-partition segment for automation-run conversations. */
export const RUN_PARTITION_SEGMENT = "_runs";

const CONVERSATIONS_SEGMENT = "conversations";
const WORKSPACES_SEGMENT = "workspaces";

/**
 * Directory holding a user's private conversations in one workspace:
 * `{workDir}/workspaces/<wsId>/conversations/<ownerId>`.
 */
export function workspaceConversationsDir(workDir: string, wsId: string, ownerId: string): string {
  // `_runs` is reserved for the automation-run partition; an ownerId equal to it
  // would make `parseConversationPath` misread that user's chats as automation
  // runs. Opaque OIDC/email ids never collide, but fail closed if one ever does.
  if (ownerId === RUN_PARTITION_SEGMENT) {
    throw new Error(
      `[conversation-paths] ownerId "${RUN_PARTITION_SEGMENT}" is reserved for automation runs`,
    );
  }
  return join(workDir, WORKSPACES_SEGMENT, wsId, CONVERSATIONS_SEGMENT, ownerId);
}

/**
 * Directory holding an automation's run conversations in one workspace:
 * `{workDir}/workspaces/<wsId>/conversations/_runs/<automationId>`. Workspace-visible
 * (the automation is a workspace artifact), distinct from the private `<ownerId>/`
 * partition.
 */
export function runConversationsDir(workDir: string, wsId: string, automationId: string): string {
  return join(
    workDir,
    WORKSPACES_SEGMENT,
    wsId,
    CONVERSATIONS_SEGMENT,
    RUN_PARTITION_SEGMENT,
    automationId,
  );
}

/** What a parsed conversation path resolves to. */
export interface ParsedConversationPath {
  wsId: string;
  /** The owner sub-partition, or `null` for an automation-run conversation. */
  ownerId: string | null;
  /** The automation id, for a `_runs/<automationId>/` conversation; else `null`. */
  automationId: string | null;
}

/**
 * Inverse of the two builders: recover `{ wsId, ownerId, automationId }` from a
 * conversation file or directory path. Returns `null` for a path that is not
 * under a `workspaces/<wsId>/conversations/...` subtree (e.g. a legacy flat
 * `conversations/<convId>.jsonl`), so the locator can skip it. The path is the
 * authority; this is how the locator recovers a conversation's workspace without
 * reading the file.
 */
export function parseConversationPath(absPath: string): ParsedConversationPath | null {
  const segments = absPath.split(sep);
  const wsIdx = segments.lastIndexOf(WORKSPACES_SEGMENT);
  if (wsIdx === -1) return null;
  const wsId = segments[wsIdx + 1];
  const convSeg = segments[wsIdx + 2];
  const partition = segments[wsIdx + 3];
  if (!wsId || convSeg !== CONVERSATIONS_SEGMENT || !partition) return null;
  if (partition === RUN_PARTITION_SEGMENT) {
    const automationId = segments[wsIdx + 4];
    if (!automationId) return null;
    return { wsId, ownerId: null, automationId };
  }
  return { wsId, ownerId: partition, automationId: null };
}
