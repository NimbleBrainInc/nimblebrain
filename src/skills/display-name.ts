/**
 * Display name for a recorded `skills.loaded` entry.
 *
 * `buildSkillsLoadedPayload` stamps `name` on every entry it emits, so this is
 * a pass-through for anything recorded since that field landed. The derivation
 * below exists only for events recorded before it, and is the ONE place that
 * derivation lives — display surfaces read the recorded name.
 *
 * Leaf module: no imports, so both the runtime read path
 * (`compose__assembled_context`) and any independently-deployable consumer can
 * take it.
 */

/**
 * The skill's name from its id, for entries predating the `name` field.
 *
 * Two id shapes reach here:
 *   - filesystem: `…/<name>.md` or `…/<name>/SKILL.md`
 *   - connector:  `skill://<skill-path>/SKILL.md` (SEP-2640 entrypoint)
 *
 * Both put the name in the last path segment EXCEPT when that segment is the
 * `SKILL.md` entrypoint marker, where the name is the directory holding it.
 * Missing that case is what rendered every connector skill as `SKILL`.
 */
function nameFromSkillId(id: string): string {
  const segments = id.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? id;
  if (/^SKILL\.md$/i.test(last) && segments.length >= 2) {
    return segments[segments.length - 2] ?? last;
  }
  return last.replace(/\.md$/i, "");
}

/** The entry's recorded name, or one derived from its id for legacy events. */
export function skillDisplayName(entry: { name?: string; id: string }): string {
  return entry.name || nameFromSkillId(entry.id);
}
