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
 *
 * This file is on the allow-list of `check:workspace-paths` (it defines the
 * `workspaces/<wsId>/...` conversation layout) and is the only site
 * `check:conversation-paths` permits.
 */

import { join, sep } from "node:path";

const CONVERSATIONS_SEGMENT = "conversations";
const WORKSPACES_SEGMENT = "workspaces";

/**
 * Directory holding a user's private conversations in one workspace:
 * `{workDir}/workspaces/<wsId>/conversations/<ownerId>`.
 */
export function workspaceConversationsDir(workDir: string, wsId: string, ownerId: string): string {
  return join(workDir, WORKSPACES_SEGMENT, wsId, CONVERSATIONS_SEGMENT, ownerId);
}

/** What a parsed conversation path resolves to. */
export interface ParsedConversationPath {
  wsId: string;
  ownerId: string;
}

/**
 * Inverse of the builder: recover `{ wsId, ownerId }` from a conversation file or
 * directory path. Returns `null` for a path that is not under a
 * `workspaces/<wsId>/conversations/<ownerId>/...` subtree (e.g. a legacy flat
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
  const ownerId = segments[wsIdx + 3];
  if (!wsId || convSeg !== CONVERSATIONS_SEGMENT || !ownerId) return null;
  return { wsId, ownerId };
}
