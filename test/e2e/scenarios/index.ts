/** Every end-to-end scenario, in the order a run takes them. */

import type { Scenario } from "../scenario.ts";
import { attachmentsChat, attachmentsRefused, fileDoors, filesDownload } from "./attachments.ts";
import { catalogsBrowse, catalogsPlugins } from "./catalogs.ts";
import { chatCancel, chatReply, chatTurn, chatWalls, conversationTools } from "./chat.ts";
import { filesInChat, filesOwnerWall, filesTools } from "./files.ts";
import { mcpAuth, mcpDoor, mcpForgedContext } from "./mcp.ts";
import { sessionBootstrap } from "./session.ts";
import { tasksAuthoring, tasksBatch, tasksNewWorkspace, tasksRun, tasksRuns } from "./tasks.ts";
import { workspacesLifecycle } from "./workspaces.ts";

export const SCENARIOS: Scenario[] = [
  // The smoke group first, so a full run reports the critical journeys first.
  sessionBootstrap,
  chatReply,
  filesDownload,
  tasksRun,
  catalogsBrowse,
  mcpAuth,
  chatTurn,
  chatCancel,
  chatWalls,
  conversationTools,
  attachmentsChat,
  attachmentsRefused,
  fileDoors,
  filesTools,
  filesInChat,
  filesOwnerWall,
  tasksAuthoring,
  tasksRuns,
  tasksBatch,
  tasksNewWorkspace,
  workspacesLifecycle,
  catalogsPlugins,
  mcpDoor,
  mcpForgedContext,
];
