import type { SkillsLoadedContext } from "../hooks/chat-store";
import type { ChatMessage } from "../hooks/useChat";

/**
 * Which turns should draw a Context Ledger line.
 *
 * The ledger reports the skills the runtime composed into a turn's prompt, and
 * an `always` skill composes into every turn by definition — so a conversation
 * that loads seven skills once loads the same seven on every turn after it.
 * Drawing that line each time states the same fact repeatedly, and repetition
 * reads as recurrence: an identical line above every answer looks like per-turn
 * work, when the skills are actually sitting in the prompt-cached prefix and
 * nothing is being re-fetched.
 *
 * So the line announces a CHANGE in equipment rather than restating the state.
 * It draws on the turn a set first appears and on any turn the set differs from
 * the turn before it; in between, silence means "still the same", and the
 * "In context" popover remains the answer to "what is equipping this right now".
 *
 * Returns an array parallel to `messages`: the payload to render at that index,
 * or `undefined` for a row that draws no line (a user turn, a turn that loaded
 * nothing, or a turn whose equipment is unchanged).
 */
export function ledgerChanges(
  messages: ReadonlyArray<ChatMessage>,
): (SkillsLoadedContext | undefined)[] {
  const out: (SkillsLoadedContext | undefined)[] = [];
  let previous = "";
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      out.push(undefined);
      continue;
    }
    const key = equipmentKey(msg.skillsLoaded);
    out.push(key !== "" && key !== previous ? msg.skillsLoaded : undefined);
    // Tracked across every assistant turn including empty ones, so equipment
    // that goes away and comes back is announced again rather than swallowed.
    previous = key;
  }
  return out;
}

/**
 * Identity of a turn's equipment — the fields the ledger actually draws,
 * combined order-independently. Two turns with the same key would render the
 * same head and the same drawer, so the second one has nothing to say.
 *
 * Sorted because composition order is an implementation detail of how the pool
 * was assembled, not something the reader sees; a reorder alone is not a change
 * worth announcing. `""` for a turn that loaded nothing.
 *
 * JSON-encoded per entry rather than joined on a separator: `reason` is free
 * text, so any separator character could also occur inside a field and let two
 * different sets encode identically.
 */
function equipmentKey(skills: SkillsLoadedContext | undefined): string {
  if (!skills || skills.skills.length === 0) return "";
  return skills.skills
    .map((s) =>
      JSON.stringify([s.id, s.name, s.connector ?? "", s.scope, s.tokens, s.loadedBy, s.reason]),
    )
    .sort()
    .join("");
}
