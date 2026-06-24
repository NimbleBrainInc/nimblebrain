/**
 * Connector-skill candidate store.
 *
 * Curated connector overlays are materialized into a workspace-local
 * `connector-skills/<server>/<skill>.md` store that is a SIBLING of the
 * authored `skills/` tree — deliberately separate so the authored-skill loader
 * (`loadConversationSkills`) never picks them up and they can never enter the
 * system prompt / Layer-3. They are CANDIDATES for the engine's
 * surface-once-into-history hook: loaded into a dedicated pool, matched by
 * tool-affinity at call time, and surfaced into the conversation history once.
 *
 * This module owns the storage convention (path, materialize, load, remove).
 * The lifecycle hooks (install/uninstall) call materialize/remove; the runtime
 * calls the loader per turn and hands the pool to the engine.
 */

import { existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorSkillCandidate } from "../engine/types.ts";
import { parseSkillContent, parseSkillFile } from "./loader.ts";
import type { SkillManifest } from "./types.ts";
import { writeSkill } from "./writer.ts";

/** Workspace subdirectory (sibling of `skills/`) holding materialized overlays. */
export const CONNECTOR_SKILLS_SUBDIR = "connector-skills";

/**
 * Scope label connector overlays carry on the engine candidate + provenance.
 * Distinct from the authored `SkillScope` union by design — connector overlays
 * are never an authored skill scope.
 */
export const CONNECTOR_SKILL_SCOPE = "connector";

export interface MaterializedConnectorSkill {
  /** Absolute path to the written skill file. */
  path: string;
  /** Skill name (file basename, sans `.md`) — matches the overlay's manifest name. */
  skillName: string;
}

/**
 * Materialize a curated overlay into `<connectorSkillsDir>/<serverName>/<skill>.md`.
 *
 * The overlay's own frontmatter supplies `name` + `description` + body; the
 * runtime fields are (re)stamped here so a materialized overlay always loads as
 * a connector candidate regardless of what the author declared:
 *   - `loading-strategy: dynamic`, `status: active`
 *   - `tool-affinity: ["<serverName>__*"]` (bound to THIS install's namespace)
 *   - `provenance: { origin: "connector", source }`
 *
 * Returns the written path + name, or `null` when the overlay body can't be
 * parsed (invalid frontmatter) — the caller treats that as non-fatal.
 */
export function materializeConnectorSkill(args: {
  connectorSkillsDir: string;
  serverName: string;
  /** The raw fetched SKILL.md (frontmatter + body). */
  overlayBody: string;
  /** Provenance source ref, e.g. `connector:composio/gmail@v0.1.0`. */
  source: string;
  /** ISO timestamp, injected for deterministic tests. */
  now: string;
}): MaterializedConnectorSkill | null {
  const serverDir = join(args.connectorSkillsDir, args.serverName);
  const parsed = parseSkillContent(args.overlayBody, join(serverDir, "overlay.md"), { cap: false });
  if (!parsed) return null;
  // An empty body has nothing to surface. Treat it as "no overlay" (like an
  // unparseable one) — symmetric with the event store dropping an empty
  // `connector.skill.injected`. Materializing it would let the engine emit on
  // every matching call (the store drops each, so no dedup marker is ever
  // written), re-emitting forever.
  if (!parsed.body.trim()) return null;

  const skillName = parsed.manifest.name;
  const manifest: SkillManifest = {
    name: skillName,
    description: parsed.manifest.description,
    loadingStrategy: "dynamic",
    priority: parsed.manifest.priority,
    status: "active",
    toolAffinity: [`${args.serverName}__*`],
    ...(parsed.manifest.allowedTools ? { allowedTools: parsed.manifest.allowedTools } : {}),
    ...(parsed.manifest.version ? { version: parsed.manifest.version } : {}),
    provenance: {
      origin: "connector",
      source: args.source,
      createdAt: args.now,
      updatedAt: args.now,
    },
  };

  writeSkill(serverDir, skillName, manifest, parsed.body);
  return { path: join(serverDir, `${skillName}.md`), skillName };
}

/**
 * Read every materialized overlay under `connectorSkillsDir` into the engine's
 * candidate shape. Each `<server>/` subdir contributes its `*.md` overlays;
 * tool-affinity comes from the file (stamped at materialize) and falls back to
 * `<server>__*`. Returns `[]` when the dir doesn't exist. A file that fails to
 * parse is skipped (one bad file never drops the pool).
 */
export function readConnectorSkillCandidates(
  connectorSkillsDir: string,
): ConnectorSkillCandidate[] {
  if (!existsSync(connectorSkillsDir)) return [];
  const out: ConnectorSkillCandidate[] = [];
  for (const server of safeReadDir(connectorSkillsDir)) {
    if (!server.isDirectory()) continue;
    const serverDir = join(connectorSkillsDir, server.name);
    for (const entry of safeReadDir(serverDir)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const skill = parseSkillFile(join(serverDir, entry.name), { cap: false });
      if (!skill) continue;
      // Skip empty-body overlays — nothing to surface, and emitting on them
      // would never dedup (the store drops the empty event). Defense for any
      // empty file that predates the materialize-time guard.
      if (!skill.body.trim()) continue;
      const affinity = skill.manifest.toolAffinity?.length
        ? skill.manifest.toolAffinity
        : [`${server.name}__*`];
      out.push({
        name: skill.manifest.name,
        body: skill.body,
        scope: CONNECTOR_SKILL_SCOPE,
        toolAffinity: affinity,
      });
    }
  }
  return out;
}

/**
 * Remove every materialized overlay for `serverName` and the (now-empty) server
 * dir. No-op when the dir is absent. Best-effort: a non-empty dir after file
 * removal (an unexpected stray entry) is left in place rather than throwing.
 */
export function removeConnectorSkillsForServer(
  connectorSkillsDir: string,
  serverName: string,
): void {
  const serverDir = join(connectorSkillsDir, serverName);
  if (!existsSync(serverDir)) return;
  for (const entry of safeReadDir(serverDir)) {
    if (entry.isFile()) unlinkSync(join(serverDir, entry.name));
  }
  try {
    rmdirSync(serverDir);
  } catch {
    // Non-empty (stray subdir) — leave it; the candidate loader only reads files.
  }
}

/** One materialized overlay, as surfaced by `manage_connectors list_bound_skills`. */
export interface ConnectorOverlayInfo {
  /** Bound server (the install's tool-namespace prefix). */
  server: string;
  /** Skill name (file basename). */
  name: string;
  /** Overlay description from frontmatter, when present. */
  description?: string;
  /** Provenance source ref, e.g. `connector:composio/gmail@v0.1.0`. */
  source?: string;
  /** Absolute path to the materialized file. */
  path: string;
}

/**
 * Enumerate every materialized overlay under `connectorSkillsDir` with its
 * provenance, for the `list_bound_skills` surface. Returns `[]` for a missing
 * dir; a file that fails to parse is skipped.
 */
export function listConnectorOverlays(connectorSkillsDir: string): ConnectorOverlayInfo[] {
  if (!existsSync(connectorSkillsDir)) return [];
  const out: ConnectorOverlayInfo[] = [];
  for (const server of safeReadDir(connectorSkillsDir)) {
    if (!server.isDirectory()) continue;
    const serverDir = join(connectorSkillsDir, server.name);
    for (const entry of safeReadDir(serverDir)) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const path = join(serverDir, entry.name);
      const skill = parseSkillFile(path, { cap: false });
      if (!skill) continue;
      out.push({
        server: server.name,
        name: skill.manifest.name,
        ...(skill.manifest.description ? { description: skill.manifest.description } : {}),
        ...(skill.manifest.provenance?.source ? { source: skill.manifest.provenance.source } : {}),
        path,
      });
    }
  }
  return out;
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
