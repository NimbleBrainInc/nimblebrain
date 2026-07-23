import type { Skill } from "./types.ts";

/**
 * Trigger-phrase skill matcher.
 *
 * Substring match on a skill's `triggers`, first hit wins. Triggers are
 * high-confidence explicit phrases for deterministic ("must-fire") activation —
 * e.g. a compliance skill that must load whenever the user names a regulated
 * action, rather than relying on the model noticing the catalog. Topic/keyword
 * matching is no longer a separate signal: the standard folds keywords into the
 * `description`, and the model activates from the catalog on that (P3).
 *
 * Only `dynamic` skills are matchable; `always` skills compose into the context
 * channel. Disabled skills (`status: "disabled"`) are excluded — a matched skill
 * is injected into Layer 4 (`<skill-instructions>`) without a further status
 * check, so this is the only place the matched-skill channel honors the toggle.
 */
/** A trigger hit: the matched skill plus the trigger phrase that fired it. */
export interface SkillMatch {
  skill: Skill;
  /** The trigger phrase (as authored) that matched — used in load telemetry. */
  trigger: string;
}

export class SkillMatcher {
  private skills: Skill[] = [];

  load(skills: Skill[]): void {
    this.skills = skills.filter(
      (s) => s.manifest.loadingStrategy === "dynamic" && s.manifest.status === "active",
    );
  }

  /** Return the loaded matchable skills (read-only snapshot). */
  getSkills(): Skill[] {
    return [...this.skills];
  }

  match(message: string): SkillMatch | null {
    if (this.skills.length === 0) return null;

    const messageLower = message.toLowerCase();

    // Trigger match (substring, first hit wins).
    for (const skill of this.skills) {
      const triggers = skill.manifest.triggers ?? [];
      for (const trigger of triggers) {
        if (messageLower.includes(trigger.toLowerCase())) {
          return { skill, trigger };
        }
      }
    }

    return null;
  }
}
