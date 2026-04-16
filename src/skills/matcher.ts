import type { Skill } from "./types.ts";

/**
 * Two-phase skill matcher.
 *
 * Phase 1: Trigger phrases -- substring match, first hit wins.
 *          Triggers are high-confidence explicit patterns.
 *
 * Phase 2: Keywords -- absolute hit count (not ratio), best match wins.
 *          Requires at least MIN_KEYWORD_HITS to qualify.
 *
 * No weights, no normalization, no tuning. A skill with 3 keywords
 * hitting 2 and a skill with 10 keywords hitting 3 both qualify.
 *
 * Only type: "skill" skills are loaded; context skills are excluded.
 */

const MIN_KEYWORD_HITS = 2;

export class SkillMatcher {
  private skills: Skill[] = [];

  load(skills: Skill[]): void {
    this.skills = skills.filter((s) => s.manifest.type === "skill");
  }

  /** Return the loaded matchable skills (read-only snapshot). */
  getSkills(): Skill[] {
    return [...this.skills];
  }

  match(message: string): Skill | null {
    if (this.skills.length === 0) return null;

    const messageLower = message.toLowerCase();

    // Phase 1: Trigger match (substring, first hit wins)
    for (const skill of this.skills) {
      const triggers = skill.manifest.metadata?.triggers ?? [];
      for (const trigger of triggers) {
        if (messageLower.includes(trigger.toLowerCase())) {
          return skill;
        }
      }
    }

    // Phase 2: Keyword match (absolute count, best wins)
    let bestSkill: Skill | null = null;
    let bestHits = 0;

    for (const skill of this.skills) {
      const keywords = skill.manifest.metadata?.keywords ?? [];
      const hits = keywords.filter((kw) => messageLower.includes(kw.toLowerCase())).length;

      if (hits >= MIN_KEYWORD_HITS && hits > bestHits) {
        bestHits = hits;
        bestSkill = skill;
      }
    }

    return bestSkill;
  }
}
