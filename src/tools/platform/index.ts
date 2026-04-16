import type { Runtime } from "../../runtime/runtime.ts";
import type { InlineSource } from "../inline-source.ts";
import { createAutomationsSource } from "./automations.ts";
import { createConversationsSource } from "./conversations.ts";
import { createFilesSource } from "./files.ts";
import { createHomeSource } from "./home.ts";
import { createSettingsSource } from "./settings.ts";
import { createUsageSource } from "./usage.ts";

/**
 * Create all platform capability sources.
 *
 * Each platform capability (conversations, files, automations, home, settings, usage)
 * becomes an InlineSource with tools and UI resources served in-process.
 * These replace the former MCP server processes for built-in bundles.
 *
 * Returns an array of InlineSources to be registered in workspace registries.
 */
export async function createPlatformSources(runtime: Runtime): Promise<InlineSource[]> {
  // Sources will be added here as each bundle is migrated.
  // Order doesn't matter — placements control UI ordering.
  return [
    createHomeSource(runtime),
    await createConversationsSource(runtime),
    createFilesSource(runtime),
    await createAutomationsSource(runtime),
    createSettingsSource(runtime),
    createUsageSource(runtime),
  ];
}
