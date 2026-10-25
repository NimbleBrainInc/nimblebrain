/**
 * Prompt containment: the fence around untrusted text the model reads, and the
 * one-line provenance beside it.
 *
 * A leaf module, with no import of its own, because the engine needs it as much
 * as the composer does: a skill delivered mid-run is fenced here, outside the
 * cached system prompt the composer builds. Nothing else of the prompt layer
 * comes with it.
 */

/**
 * The closed set of containment tags the composer may open around untrusted
 * body content. Membership here is the allow-list: you cannot wrap content in
 * a tag that is not in this union — an unknown tag is a compile error, which
 * kills the wrong-tag copy-paste class at type-check time.
 */
export type ContainmentTag =
  | "context-skill"
  | "runtime-context"
  | "app-instructions"
  | "app-description"
  | "app-resource-templates"
  | "app-guide"
  | "app-state"
  | "layer3-skill"
  | "connector-skill"
  | "connector-instructions"
  | "activated-skill"
  | "skill-instructions"
  | "run-input"
  | "judge-feedback"
  | "host-instructions"
  | "conversation-history";

/**
 * Wrap untrusted `body` in `<tag>…</tag>`, neutralising every closing form of
 * `tag` inside `body` so the body cannot break out of containment. The open
 * tag, the escaped close form, and the trailing close are all derived from the
 * single `tag` argument — they are incapable of diverging. Returns the FULL
 * block (open + escaped body + close); callers never write the literal tag.
 *
 * The escape is case-insensitive and whitespace-tolerant on purpose: the
 * parser on the other side is an LLM, not a conforming XML reader, and it will
 * honor `</TAG>`, `</tag >`, `</ tag>`, `</tag\n>` as closes that an
 * exact-substring `replaceAll` would pass straight through. This is the
 * security-load-bearing behavior.
 */
export function wrapContained(tag: ContainmentTag, body: string): string {
  // `tag` values are fixed lowercase `[a-z-]` literals — no regex metachars to
  // escape. Do NOT widen `ContainmentTag` to include a regex metacharacter
  // without escaping it here. The `gi` flag plus `\s*` around the `/` and tag
  // normalise every realistic close variant — `</TAG>`, `</tag >`, `< /tag>`,
  // `</ tag>`, `</tag\n>` — to the single safe `&lt;/${tag}>`, since the
  // consumer is a fuzzy LLM parser rather than a conforming XML reader.
  const closing = new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi");
  const safe = body.replace(closing, `&lt;/${tag}>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

/**
 * Strip newlines and control characters from single-line fields.
 * Prevents structural injection via displayName, timezone, locale, app name.
 *
 * `String()` rather than trusting the parameter type: several callers pass
 * fields that are typed `string` but originate in unvalidated JSON — persisted
 * `ConnectorRef.ui`, registry `_meta`, `nimblebrain.json` — so a non-string
 * reaches here at runtime. Coercing reproduces what the template literal at
 * each call site did before this function guarded it, which keeps a malformed
 * record inert instead of throwing out of `composeSystemPrompt` on every turn.
 * Identity on strings, so the common path is unchanged.
 */
export function sanitizeLineField(value: string): string {
  return (
    String(value)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: a newline or control byte in a field could open a forged prompt line, so matching them is the mitigation
      .replace(/[\n\r\x00-\x1f\x7f]/g, " ")
      .trim()
  );
}

/**
 * Wrap a connector-skill overlay body for surfacing into the conversation
 * history. Unlike Layer-3 skills, a connector overlay delivered automatically
 * never enters the cached system prefix — it becomes the body of a synthetic
 * message the reconstructor emits on the first matching connector tool call,
 * so the guidance rides the append-only history rather than re-varying the
 * prompt prefix every turn. An overlay a task declares by name is the
 * exception: it joins Layer 3, where it is identical across the task's runs.
 *
 * Containment is the same per-prompt defense `formatLayer3SkillsSection`
 * applies (connector trust is install-time; this is the per-prompt guard): the
 * body is wrapped in `<connector-skill>` and any literal closing tag inside it
 * is rewritten to `&lt;/connector-skill>` so an overlay author can't break out
 * of containment. Name/scope ride a sanitized provenance line.
 */
export function formatConnectorSkillBlock(
  name: string,
  scope: string,
  body: string,
  heldCall = false,
): string {
  const safeName = sanitizeLineField(name);
  const safeScope = sanitizeLineField(scope);
  const how = heldCall
    ? "governs the call held above; call it again once read"
    : "surfaced on first matching connector tool call";
  const provenance = `_${safeName}_ — scope: ${safeScope}; ${how}`;
  return `${provenance}\n\n${wrapContained("connector-skill", body)}`;
}

/**
 * Wrap a catalog skill's body for delivery as the `nb__use_skill` tool result.
 * Sibling of {@link formatConnectorSkillBlock} with the same discipline —
 * sanitized one-line provenance, then the body in `<activated-skill>`
 * containment with its closing form escaped — differing only in the tag and
 * the provenance verb (loaded on request, not surfaced by tool affinity).
 * The result persists in history via the normal `tool.done` event, so this
 * block IS the durable in-context copy of the skill.
 */
export function formatActivatedSkillBlock(name: string, scope: string, body: string): string {
  const safeName = sanitizeLineField(name);
  const safeScope = sanitizeLineField(scope);
  const provenance = `_${safeName}_ — scope: ${safeScope}; loaded from the skill catalog`;
  return `${provenance}\n\n${wrapContained("activated-skill", body)}`;
}
