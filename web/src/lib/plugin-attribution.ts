// ---------------------------------------------------------------------------
// Plugin attribution — which plugin a tool call or a loaded skill came from.
//
// Pure lookups over a workspace's plugin listing (`listPlugins`). A miss is an
// answer, not an error: kernel and identity tools (`nb`, `conversations`,
// `files`, `skills`, …) are in no plugin, a connector removed since the call
// ran is no longer listed, and a filesystem skill belongs to no plugin. Each
// renders as it did before attribution existed: unlabeled.
// ---------------------------------------------------------------------------

import type { Plugin } from "../_generated/platform-schemas/plugins";
import {
  appNameFromToolName,
  isPersonalConnectorAppName,
  personalConnectorServerName,
} from "./namespaced-tool";
import { personalPluginNamed, requestPluginArg } from "./plugin-request";

/**
 * The plugin a wire tool name's source belongs to.
 *
 * The source segment decides the door (CONTEXT.md, "tool namespacing"): a bare
 * source is a workspace connector, a `my_`-marked one the caller's personal
 * connector of that server name. Both kinds may share a server name, so the
 * owner kind is part of the match.
 */
export function pluginForTool(toolName: string, plugins: readonly Plugin[]): Plugin | undefined {
  const source = appNameFromToolName(toolName);
  if (!source) return undefined;
  const personal = isPersonalConnectorAppName(source);
  const serverName = personal ? personalConnectorServerName(source) : source;
  const kind = personal ? "person" : "workspace";
  return plugins.find(
    (p) => p.owner.kind === kind && p.servers.some((s) => s.serverName === serverName),
  );
}

/**
 * Manifest-name prefix of a skill a connector publishes, as the skill catalog
 * and `nb__use_skill` name it: `connector:<server>:<name>`. Mirrors
 * `CONNECTOR_SKILL_NAME_PREFIX` in `src/skills/connector-skills.ts`.
 */
const CONNECTOR_SKILL_NAME_PREFIX = "connector:";

/** A skill as the timeline knows it: a ledger row, or a skill-loading call's `name`. */
export interface SkillRef {
  /** The skill's name: bare, or the catalog's `connector:<server>:<name>` form. */
  name: string;
  /** The server that published it, when the reference says so (the ledger does). */
  connector?: string;
}

/**
 * The plugin a skill comes with (`plugins[].skills[]`), or undefined for a
 * skill that belongs to none (an authored one).
 *
 * A published skill is identified by its server and name together, because
 * connectors conventionally name guidance for its job (`usage`) and collide.
 * A bare name with no server can only be a curated overlay, which the catalog
 * names plainly.
 */
export function pluginForSkill(ref: SkillRef, plugins: readonly Plugin[]): Plugin | undefined {
  return plugins.find((p) =>
    p.skills.some((s) => {
      if (ref.connector) return s.serverName === ref.connector && s.name === ref.name;
      if (ref.name.startsWith(CONNECTOR_SKILL_NAME_PREFIX)) {
        return ref.name === `${CONNECTOR_SKILL_NAME_PREFIX}${s.serverName}:${s.name}`;
      }
      return s.kind === "overlay" && s.name === ref.name;
    }),
  );
}

/**
 * Tools whose call puts a skill into the conversation, and the input naming it:
 * `nb__use_skill` loads one from the catalog; `skills__activate` un-mutes one,
 * so it composes again.
 */
const SKILL_NAMING_INPUT: Readonly<Record<string, string>> = {
  nb__use_skill: "name",
  skills__activate: "id",
};

/**
 * The plugin a tool call is attributed to: the plugin the tool comes from; for
 * a call that loads or activates a skill (a kernel tool), the plugin that skill
 * comes with; for a plugin request, the caller's plugin it asks for.
 */
export function pluginForCall(
  call: { name: string; input?: Record<string, unknown> },
  plugins: readonly Plugin[],
): Plugin | undefined {
  // A plugin request (a kernel tool) is attributed to the plugin it asks for.
  const requested = requestPluginArg(call);
  if (requested) return personalPluginNamed(plugins, requested);
  const key = SKILL_NAMING_INPUT[call.name];
  if (key) {
    const name = call.input?.[key];
    return typeof name === "string" && name ? pluginForSkill({ name }, plugins) : undefined;
  }
  return pluginForTool(call.name, plugins);
}

/**
 * The one plugin every call in a group is attributed to, or undefined when any
 * call has none or they differ. A group label names a plugin only when it is
 * true of the whole group.
 */
export function sharedPlugin(
  calls: ReadonlyArray<{ name: string; input?: Record<string, unknown> }>,
  plugins: readonly Plugin[],
): Plugin | undefined {
  let shared: Plugin | undefined;
  for (const call of calls) {
    const plugin = pluginForCall(call, plugins);
    if (!plugin || (shared && shared.id !== plugin.id)) return undefined;
    shared = plugin;
  }
  return shared;
}
