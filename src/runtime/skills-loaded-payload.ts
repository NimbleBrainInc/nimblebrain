import { createHash } from "node:crypto";
import type { SelectedSkill } from "../skills/select.ts";
import type { SkillsLoadedPayload } from "../engine/types.ts";
import { readSkillMtime } from "../skills/loader.ts";
import { approxTokens } from "../skills/tokens.ts";

/**
 * Build the `skills.loaded` payload from the Layer 3 selection result.
 *
 * Each entry carries:
 *   - `id` — sourcePath, or an in-memory sentinel for skills synthesized at
 *     runtime (workspace identity overrides, etc.)
 *   - `scope` — defaults to `org` when the manifest doesn't pin one
 *   - `version` — file mtime as a stable change marker, "" for in-memory
 *   - `tokens` — approximate, summed into the payload total
 *   - `contentHash` — SHA-256 hex of the body that was composed into the
 *     prompt. Lets debug tools detect mutation between when the skill loaded
 *     and when an operator inspects it (see `SkillsLoadedEntry` for full
 *     rationale).
 *   - `loadedBy` / `reason` — propagated from the selector for telemetry.
 *
 * Pure function; no FS access beyond the mtime read for `version`.
 */
export function buildSkillsLoadedPayload(selected: SelectedSkill[]): SkillsLoadedPayload {
  const entries = selected.map((s) => {
    const body = s.skill.body;
    const tokens = approxTokens(body);
    const sourcePath = s.skill.sourcePath || "";
    return {
      id: sourcePath || `skill-in-memory:${s.skill.manifest.name}`,
      layer: 3 as const,
      scope: (s.skill.manifest.scope ?? "org") as "org" | "workspace" | "user" | "bundle",
      version: sourcePath ? readSkillMtime(sourcePath) : "",
      tokens,
      contentHash: hashSkillBody(body),
      loadedBy: s.loadedBy,
      reason: s.reason,
    };
  });
  const totalTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  return { skills: entries, totalTokens };
}

/**
 * SHA-256 hex of a skill body. The hash is over the body text alone (not
 * the frontmatter) since the composed prompt only embeds the body.
 *
 * Exported separately so debug tools that re-hash an on-disk skill use the
 * exact same bytes-to-digest pipeline as the emitter — drift between the
 * two paths would silently break mutation detection.
 */
export function hashSkillBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
