/**
 * Model slot names and the reference syntax that reaches them.
 *
 * A slot is a *role* ("the cheap auxiliary model"), not a model id. Config,
 * agent profiles, and per-request overrides all name slots, so the list and
 * the parser live here rather than being restated per consumer — when a slot
 * is added or removed, one edit moves every reader.
 */

/** Known model slot names. */
export const MODEL_SLOTS = ["default", "fast", "reasoning"] as const;

export type ModelSlot = (typeof MODEL_SLOTS)[number];

const ALIAS_PREFIX = "alias:";

export function isModelSlot(s: string): s is ModelSlot {
  return (MODEL_SLOTS as readonly string[]).includes(s);
}

/**
 * Resolve a model string to a slot name, or null when it names a concrete model.
 *
 * Two spellings, both slots: the explicit `alias:fast`, and the bare `fast`
 * that `workspace.json`'s agent profiles document (`"model": "reasoning"`).
 * The bare form is the one authors actually write, and it used to fall through
 * to `resolveModelString`, which finds no catalog entry and applies its
 * pinned-id fallback — turning `"reasoning"` into `anthropic:reasoning`, a
 * model that does not exist, and failing at the provider rather than here.
 *
 * A slot name cannot collide with a real model id — the catalog is keyed by
 * vendor ids (`claude-sonnet-4-6`) — so accepting the bare form shadows
 * nothing. `model-slots.test.ts` asserts that against the merged catalog, so a
 * provider shipping a model literally named `fast` fails the build instead of
 * silently becoming unreachable.
 */
export function parseModelSlotRef(s: string): ModelSlot | null {
  const bare = s.startsWith(ALIAS_PREFIX) ? s.slice(ALIAS_PREFIX.length) : s;
  return isModelSlot(bare) ? bare : null;
}
