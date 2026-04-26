/**
 * Settings platform source — in-process MCP server.
 * Migrated from the former @nimblebraininc/settings MCP bundle.
 *
 * Provides 4 read-only tools (manifest, section, config, identity),
 * the settings panel HTML resource (`ui://settings/panel`), and a
 * sidebar.bottom placement.
 */

import { join } from "node:path";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { SETTINGS_PANEL_HTML } from "../platform-resources/settings/panel.ts";
import { getIdentityStatus } from "./helpers/identity-status.ts";
import { getRuntimeConfig } from "./helpers/runtime-config.ts";
import { settingsBundlesSection } from "./sections/bundles.ts";
import { settingsIdentitySection } from "./sections/identity.ts";
import { settingsConfigSection } from "./sections/model.ts";
import { settingsProfileSection } from "./sections/profile.ts";
import { settingsSkillsSection } from "./sections/skills.ts";
import { settingsSystemSection } from "./sections/system.ts";
import { settingsUsageSection } from "./sections/usage.ts";
import { CORE_SECTIONS } from "./settings-types.ts";

// ---------------------------------------------------------------------------
// Section router
// ---------------------------------------------------------------------------

const coreSectionRenderers: Record<string, () => string> = {
  profile: () => settingsProfileSection(),
  identity: () => settingsIdentitySection(),
  skills: () => settingsSkillsSection(),
  bundles: () => settingsBundlesSection(),
  model: () => settingsConfigSection(),
  usage: () => settingsUsageSection(),
  system: () => settingsSystemSection(),
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the settings platform source (in-process MCP server).
 *
 * Provides manifest, section, config, and identity tools plus the settings
 * panel HTML resource and a sidebar.bottom placement.
 */
export function createSettingsSource(runtime: Runtime, eventSink: EventSink): McpSource {
  const workDir = runtime.getWorkDir();
  const configPath = join(workDir, "nimblebrain.json");
  const skillsDir = join(workDir, "skills");
  // Core skills are shipped with the package
  const coreSkillsDir = join(import.meta.dirname ?? __dirname, "../../skills/core");

  const tools: InProcessTool[] = [
    {
      name: "manifest",
      description:
        "Returns the manifest of all available settings sections (core + bundle-contributed).",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (_input: Record<string, unknown>): Promise<ToolResult> => {
        const sections = [...CORE_SECTIONS];
        return {
          content: textContent(JSON.stringify({ sections }, null, 2)),
          isError: false,
        };
      },
    },
    {
      name: "section",
      description: "Returns the HTML content for a specific settings section by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "Settings section ID (e.g., 'identity', 'skills', 'bundles', 'model').",
          },
        },
        required: ["id"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const id = String(input.id);
        const renderer = coreSectionRenderers[id];
        if (!renderer) {
          return {
            content: textContent(JSON.stringify({ error: `Unknown settings section: "${id}"` })),
            isError: true,
          };
        }
        const html = renderer();
        return {
          content: textContent(JSON.stringify({ html }, null, 2)),
          isError: false,
        };
      },
    },
    {
      name: "config",
      description:
        "Returns the current runtime configuration values (model, iteration limits, token limits, available models) and the current user's preferences.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (_input: Record<string, unknown>): Promise<ToolResult> => {
        const result = getRuntimeConfig(configPath);

        // Override preferences with the current user's profile preferences
        const identity = runtime.getCurrentIdentity();
        if (identity?.preferences) {
          const p = identity.preferences;
          result.preferences = {
            displayName: identity.displayName || result.preferences.displayName,
            timezone: p.timezone || result.preferences.timezone,
            locale: p.locale || result.preferences.locale,
            theme: p.theme || result.preferences.theme,
          };
        }

        return {
          content: textContent(JSON.stringify(result, null, 2)),
          isError: false,
        };
      },
    },
    {
      name: "identity",
      description:
        "Returns the current identity configuration: core identity (soul.md), optional user override, and the effective combined identity.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
      handler: async (_input: Record<string, unknown>): Promise<ToolResult> => {
        const wsId = runtime.getCurrentWorkspaceId();
        let workspaceIdentity: string | undefined;
        if (wsId) {
          const ws = await runtime.getWorkspaceStore().get(wsId);
          workspaceIdentity = ws?.identity ?? undefined;
        }
        const result = getIdentityStatus(skillsDir, coreSkillsDir, workspaceIdentity);
        return {
          content: textContent(JSON.stringify(result, null, 2)),
          isError: false,
        };
      },
    },
  ];

  const resources = new Map([["ui://settings/panel", SETTINGS_PANEL_HTML]]);

  return defineInProcessApp(
    {
      name: "settings",
      version: "1.0.0",
      tools,
      resources,
      placements: [
        {
          slot: "sidebar.bottom",
          route: "settings",
          label: "Settings",
          icon: "settings",
          priority: 90,
          resourceUri: "",
        },
      ],
    },
    eventSink,
  );
}
