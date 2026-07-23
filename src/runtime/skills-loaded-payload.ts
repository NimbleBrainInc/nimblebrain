import { createHash } from "node:crypto";
import type { SkillsLoadedPayload } from "../engine/types.ts";
import { readSkillMtime } from "../skills/loader.ts";
import type { SkillMatch } from "../skills/matcher.ts";
import type { LoadedBy, SelectedSkill } from "../skills/select.ts";
import { approxTokens } from "../skills/tokens.ts";
import type { Skill } from "../skills/types.ts";

/** The mechanism's layer: 0 = always-on context, 3 = tool-affinity, 4 = trigger. */
function layerForMechanism(loadedBy: LoadedBy): 0 | 3 | 4 {
  switch (loadedBy) {
    case "always":
      return 0;
    case "trigger":
      return 4;
    default:
      return 3;
  }
}

/** Stable identity for de-duplicating a skill across loading mechanisms. */
function skillKey(skill: Skill): string {
  return skill.sourcePath || `name:${skill.manifest.name}`;
}

/**
 * Unify every loading mechanism for a turn into one selected set for
 * `skills.loaded` telemetry, so the Context Ledger reports the full picture,
 * not just tool-affinity:
 *
 *   - `toolAffinity` — the Layer-3 selection (`selectLayer3Skills`), verbatim.
 *   - `trigger`      — the `SkillMatcher` hit, if any → reason
 *     `trigger matched "<phrase>"`.
 *   - `alwaysOn`     — the always-on context skills composed this turn (persona
 *     override, org/workspace/user + bundle always-on skills) → reason
 *     `always-on`. Platform-vendored core skills (soul, capabilities) are
 *     EXCLUDED — they load every turn in every tenant, so surfacing them would
 *     drown the ambient line and leak internals.
 *
 * De-duplicated by skill identity with tool-affinity taking precedence (the
 * established channel), so a `dynamic` skill that both trigger- and
 * affinity-matches is reported once. Pure — no FS access, no emission.
 */
export function collectLoadedSkills(input: {
  toolAffinity: SelectedSkill[];
  trigger?: SkillMatch | null;
  alwaysOn: Skill[];
}): SelectedSkill[] {
  const out: SelectedSkill[] = [];
  const seen = new Set<string>();
  const push = (sel: SelectedSkill): void => {
    const key = skillKey(sel.skill);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sel);
  };

  for (const s of input.toolAffinity) push(s);
  if (input.trigger) {
    push({
      skill: input.trigger.skill,
      loadedBy: "trigger",
      reason: `trigger matched "${input.trigger.trigger}"`,
    });
  }
  for (const s of input.alwaysOn) {
    if (s.manifest.provenance?.origin === "vendored") continue;
    push({ skill: s, loadedBy: "always", reason: "always-on" });
  }

  return out;
}

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
      layer: layerForMechanism(s.loadedBy),
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
