import type { EventSink } from "../engine/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { ToolSource } from "../tools/types.ts";
import { createAutomationsSource } from "./automations/source.ts";
import { createComposeSource } from "./compose/source.ts";
import { createConversationsSource } from "./conversations/source.ts";
import { createFilesSource } from "./files/source.ts";
import { createHomeSource } from "./home/source.ts";
import { createHooksSource } from "./hooks/source.ts";
import { createInstructionsSource } from "./instructions/source.ts";
import { createNotificationsSource } from "./notifications/source.ts";
import { createSkillsSource } from "./skills/source.ts";
import { createUsageSource } from "./usage/source.ts";

/**
 * Create every platform app source, started and ready to register.
 *
 * A platform app is an in-process MCP server (`defineInProcessApp`) that talks
 * to the runtime over the same MCP transport a remote connector does — just an
 * `InMemoryTransport` instead of stdio/HTTP. They have tools, resources,
 * placements, and (in the future) any other MCP capability the SDK adds.
 *
 * Sources are returned already-started: `McpSource.start()` is what wires
 * the in-memory transport pair and runs the MCP `initialize` handshake, so
 * the source isn't usable until that's done. Callers shouldn't have to
 * remember to start them — the factory hands back a ready object.
 *
 * The platform "settings" source was deleted in favor of the React org
 * settings pages (`/settings/org/*` → `web/src/pages/settings/*Tab.tsx`).
 * The agent-facing config tools (`nb__get_config`, `nb__set_model_config`)
 * already cover the same surface; the iframe-mounted settings panel had
 * no live consumer in the web shell.
 */
export async function createPlatformSources(
  runtime: Runtime,
  eventSink: EventSink,
): Promise<ToolSource[]> {
  // Order doesn't matter — placements control UI ordering.
  const sources: ToolSource[] = [
    createHomeSource(runtime, eventSink),
    await createConversationsSource(runtime, eventSink),
    createFilesSource(runtime, eventSink),
    await createAutomationsSource(runtime, eventSink),
    createUsageSource(runtime, eventSink),
    createInstructionsSource(runtime, eventSink),
    createHooksSource(runtime, eventSink),
    createNotificationsSource(runtime, eventSink),
    createSkillsSource(runtime, eventSink, runtime.getFeatures()),
    createComposeSource(runtime, eventSink),
  ];

  // start() builds the in-process MCP server + InMemoryTransport pair and
  // runs `initialize`, so the source is ready to serve tools and resources
  // as soon as this returns.
  for (const src of sources) {
    await src.start();
  }

  return sources;
}
