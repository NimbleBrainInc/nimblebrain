/**
 * Managed skills (ADR-0077): the skills an installed plugin produced, marked
 * with their plugin and read-only. Update replaces them and uninstall removes
 * them; a person who wants to change one makes their own copy, which no plugin
 * touches.
 *
 * Where one lives depends on whether it names one of its plugin's servers:
 *
 * - **Bound** (its `metadata.nimblebrain.server` is a server key): it is that
 *   connection's guidance, materialized into the owner's `connector-skills/`
 *   store as `<serverName>/<name>.md`, `dynamic` and tool-affined to the
 *   connection's namespace, so it reaches the model before the connector's
 *   first tool call (ADR-0053). `materializeConnectorSkill` writes it.
 * - **Unbound**: it loads by the ordinary channels, from the owner's
 *   `plugin-skills/<plugin>/<name>.md`, into that owner's skill pool under the
 *   name `plugin:<name>@<catalog>:<skill>` (ADR-0068), so no two plugins'
 *   skills shadow each other or an authored skill.
 *
 * Each file's provenance `source` is `plugin:<address>:<skill>`: the mark that
 * makes it managed, the one the skill tools refuse to edit and the one
 * uninstall checks before removing a file.
 */

import { existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { PluginOwner } from "../plugins/installed/record.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { CONNECTOR_SKILLS_SUBDIR, materializeConnectorSkill } from "./connector-skill-store.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { parseSkillFile, parseSkillParts } from "./loader.ts";
import type { Skill, SkillManifest } from "./types.ts";
import { writeSkill } from "./writer.ts";

/** The owner subdirectory holding unbound managed skills, a sibling of `skills/`. */
export const MANAGED_SKILLS_SUBDIR = "plugin-skills";

/** The provenance prefix every managed skill carries. */
export const MANAGED_SKILL_SOURCE_PREFIX = "plugin:";

/** A managed skill's provenance source: `plugin:<address>:<skill>`. */
export function managedSkillSource(address: string, skill: string): string {
  return `${MANAGED_SKILL_SOURCE_PREFIX}${address}:${skill}`;
}

/** The plugin address a provenance source names, when it is a managed skill's. */
export function managedSkillPlugin(source: string | undefined): string | null {
  if (!source?.startsWith(MANAGED_SKILL_SOURCE_PREFIX)) return null;
  const rest = source.slice(MANAGED_SKILL_SOURCE_PREFIX.length);
  const at = rest.lastIndexOf(":");
  return at > 0 ? rest.slice(0, at) : null;
}

/** An owner's two managed-skill stores. */
export interface ManagedSkillRoots {
  /** `connector-skills/`: bound skills, by connection. */
  connectorSkills: string;
  /** `plugin-skills/`: unbound skills, by plugin. */
  pluginSkills: string;
}

export function managedSkillRoots(workDir: string, owner: PluginOwner): ManagedSkillRoots {
  if (owner.kind === "workspace") {
    const ctx = new WorkspaceContext({ wsId: owner.wsId, workDir });
    return {
      connectorSkills: ctx.getDataPath(CONNECTOR_SKILLS_SUBDIR),
      pluginSkills: ctx.getDataPath("root", MANAGED_SKILLS_SUBDIR),
    };
  }
  // Validated the way `IdentityContext` validates it: one safe path segment.
  if (!/^[A-Za-z0-9_.@-]+$/.test(owner.userId) || owner.userId.startsWith(".")) {
    throw new Error(`[managed-skills] invalid user id "${owner.userId}"`);
  }
  const root = join(workDir, "users", owner.userId);
  return {
    connectorSkills: join(root, CONNECTOR_SKILLS_SUBDIR),
    pluginSkills: join(root, MANAGED_SKILLS_SUBDIR),
  };
}

/** A plugin's directory name in `plugin-skills/`: its address, with anything unsafe a hyphen. */
export function pluginSkillsDirName(address: string): string {
  return address.replace(/[^A-Za-z0-9._@-]/g, "-").replace(/^\.+/, "-");
}

/** One materialized managed skill: the name it loads under in its store, and its file. */
export interface MaterializedManagedSkill {
  name: string;
  path: string;
}

/**
 * Materialize one managed skill. `serverName` is set for a bound skill (the
 * connection it guides). Returns null when the `SKILL.md` does not parse or
 * has an empty body, which installs no skill.
 */
export function materializeManagedSkill(args: {
  roots: ManagedSkillRoots;
  address: string;
  skill: string;
  body: string;
  serverName?: string;
  now: string;
}): MaterializedManagedSkill | null {
  const source = managedSkillSource(args.address, args.skill);
  if (args.serverName) {
    const written = materializeConnectorSkill({
      connectorSkillsDir: args.roots.connectorSkills,
      serverName: args.serverName,
      overlayBody: args.body,
      source,
      now: args.now,
    });
    return written ? { name: written.skillName, path: written.path } : null;
  }
  const dir = join(args.roots.pluginSkills, pluginSkillsDirName(args.address));
  let parsed: Skill | null;
  try {
    const { data, content } = parseFrontmatter(args.body);
    parsed = parseSkillParts(withoutBinding(data), content, join(dir, `${args.skill}.md`), {
      cap: false,
    });
  } catch {
    return null;
  }
  if (!parsed?.body.trim()) return null;
  const manifest: SkillManifest = {
    ...parsed.manifest,
    status: "active",
    provenance: { origin: "import", source, createdAt: args.now, updatedAt: args.now },
  };
  delete manifest.scope;
  writeSkill(dir, manifest.name, manifest, parsed.body);
  return { name: manifest.name, path: join(dir, `${manifest.name}.md`) };
}

/**
 * Drop `server` from `metadata.nimblebrain` (a binding to a key the plugin
 * does not have) and fill the `loading-strategy` the schema requires of a
 * block that names none.
 */
function withoutBinding(data: Record<string, unknown>): Record<string, unknown> {
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const nb = metadata?.nimblebrain as Record<string, unknown> | undefined;
  if (!nb || typeof nb !== "object") return data;
  const { server: _server, ...rest } = nb;
  return {
    ...data,
    metadata: { ...metadata, nimblebrain: { "loading-strategy": "dynamic", ...rest } },
  };
}

/**
 * Remove one managed skill this plugin materialized, by the name it loads
 * under. The file goes only when its provenance still names this plugin: a
 * skill of the same name another plugin wrote over it since is that plugin's.
 */
export function removeManagedSkill(args: {
  roots: ManagedSkillRoots;
  address: string;
  name: string;
  serverName?: string;
}): void {
  const dir = args.serverName
    ? join(args.roots.connectorSkills, args.serverName)
    : join(args.roots.pluginSkills, pluginSkillsDirName(args.address));
  const file = join(dir, `${args.name}.md`);
  if (!existsSync(file)) return;
  const skill = parseSkillFile(file, { cap: false });
  if (skill && managedSkillPlugin(skill.manifest.provenance?.source) !== args.address) return;
  unlinkSync(file);
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // A directory that cannot be listed or removed holds nothing the loaders read as ours.
  }
}

/**
 * Every unbound managed skill in `pluginSkillsDir`, for the owner's skill pool:
 * read-only (`provided`), named `plugin:<address>:<skill>`.
 */
export function loadManagedPoolSkills(pluginSkillsDir: string): Skill[] {
  if (!existsSync(pluginSkillsDir)) return [];
  const out: Skill[] = [];
  for (const plugin of safeReadDir(pluginSkillsDir)) {
    if (!plugin.isDirectory()) continue;
    const dir = join(pluginSkillsDir, plugin.name);
    for (const entry of safeReadDir(dir)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const skill = readPoolSkill(join(dir, entry.name));
      if (skill) out.push(skill);
    }
  }
  return out;
}

/** One unbound managed skill as its pool holds it, or null when it is not one. */
function readPoolSkill(path: string): Skill | null {
  let skill: Skill | null;
  try {
    skill = parseSkillFile(path, { cap: true });
  } catch {
    return null;
  }
  const address = managedSkillPlugin(skill?.manifest.provenance?.source);
  if (!skill || !address) return null;
  skill.manifest = {
    ...skill.manifest,
    name: `plugin:${address}:${skill.manifest.name}`,
    scope: "provided",
  };
  return skill;
}

/**
 * Whether `path` sits in a managed-skill store under `workDir`: an owner's
 * `plugin-skills/` or `connector-skills/` directory. The skill tools refuse to
 * write such a file whatever its contents.
 */
export function isManagedSkillPath(workDir: string, path: string): boolean {
  const rel = relative(resolve(workDir), resolve(path));
  if (rel.startsWith("..") || rel === "") return false;
  const [tier, owner, store, entry] = rel.split(sep);
  return (
    (tier === "workspaces" || tier === "users") &&
    !!owner &&
    (store === MANAGED_SKILLS_SUBDIR || store === CONNECTOR_SKILLS_SUBDIR) &&
    !!entry
  );
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Remove the files in one connection's `connector-skills/<serverName>/` that
 * no plugin in `keep` owns: what an earlier binding of the connection left
 * there (a skill written by the zip-scanning resolver, marked with that
 * plugin's name in its catalog index). A skill whose provenance names a
 * plugin in `keep` stays, so a skill rewritten in place is never lost and a
 * skill another installed plugin binds to the same connection is untouched.
 * Returns the names removed.
 */
export function removeUnownedConnectorSkills(args: {
  roots: ManagedSkillRoots;
  serverName: string;
  keep: ReadonlySet<string>;
}): string[] {
  const dir = join(args.roots.connectorSkills, args.serverName);
  const removed: string[] = [];
  for (const entry of safeReadDir(dir)) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const file = join(dir, entry.name);
    let owner: string | null = null;
    try {
      owner = managedSkillPlugin(parseSkillFile(file, { cap: false })?.manifest.provenance?.source);
    } catch {
      owner = null;
    }
    if (owner && args.keep.has(owner)) continue;
    unlinkSync(file);
    removed.push(entry.name.replace(/\.md$/i, ""));
  }
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // A directory that cannot be listed or removed holds nothing the loaders read as ours.
  }
  return removed;
}
