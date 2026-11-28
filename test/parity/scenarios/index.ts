/** Every parity scenario, in the order a run takes them. */

import type { Scenario } from "../scenario.ts";
import { attachmentsChat, attachmentsRefused, fileDoors } from "./attachments.ts";
import { catalogsPlugins } from "./catalogs.ts";
import { chatCancel, chatTurn, chatWalls, conversationTools } from "./chat.ts";
import { filesInChat, filesOwnerWall, filesTools } from "./files.ts";
import { mcpDoor, mcpForgedContext } from "./mcp.ts";
import { tasksAuthoring, tasksBatch, tasksNewWorkspace, tasksRuns } from "./tasks.ts";
import { workspacesLifecycle } from "./workspaces.ts";

export const SCENARIOS: Scenario[] = [
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
