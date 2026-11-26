/**
 * The kernel's conversation store over the built-in conversations plugin, in
 * process: the contract adapter (`src/conversation/contract-store.ts`) calling
 * the plugin's own tool dispatch (`packages/conversations/src/server.ts`) on a
 * data directory, as the host does over stdio. A unit test gets the store the
 * runtime uses without starting a server.
 */

import { join } from "node:path";
import { callTool } from "../../packages/conversations/src/server.ts";
import { createStore } from "../../packages/conversations/src/store.ts";
import {
  type ContractConversations,
  type ContractScope,
  createContractConversations,
} from "../../src/conversation/contract-store.ts";
import type { ConversationEventStore } from "../../src/conversation/types.ts";
import { ContractToolError } from "../../src/plugins/bound-servers.ts";
import { pluginDataDir } from "../../src/plugins/index.ts";

/** The contract store over the plugin's store at `dataDir`. */
export function inProcessConversations(
  dataDir: string,
  opts: { assertWorkspace?: (scope: ContractScope) => void } = {},
): ContractConversations {
  const store = createStore(dataDir);
  return createContractConversations(
    async (tool, args, scope) => {
      const result = await callTool(store, tool, args, { principal: "host", ...scope });
      if ("isError" in result && result.isError) {
        const { code, error } = JSON.parse(result.content[0]?.text ?? "{}") as {
          code: string;
          error: string;
        };
        throw new ContractToolError(code, error);
      }
      return (result.structuredContent ?? {}) as Record<string, unknown>;
    },
    { assertWorkspace: opts.assertWorkspace ?? (() => {}) },
  );
}

/** One owner's conversations in one workspace, stored under `dataDir`. */
export function conversationStore(
  dataDir: string,
  workspaceId: string,
  ownerId: string,
): ConversationEventStore {
  return inProcessConversations(dataDir).forScope({ workspaceId, ownerId });
}

/** The built-in conversations plugin's data directory under a runtime's work directory. */
export function conversationsDataDir(workDir: string): string {
  return pluginDataDir(workDir, "conversations");
}

/** Where the built-in plugin keeps one owner's conversations in one workspace, under a runtime's work directory. */
export function ownerConversationsDir(
  workDir: string,
  workspaceId: string,
  ownerId: string,
): string {
  return join(conversationsDataDir(workDir), "workspaces", workspaceId, "conversations", ownerId);
}

/** The conversation store a runtime on `workDir` reads, opened beside it on the same data directory. */
export function workDirConversationStore(
  workDir: string,
  workspaceId: string,
  ownerId: string,
): ConversationEventStore {
  return conversationStore(conversationsDataDir(workDir), workspaceId, ownerId);
}
