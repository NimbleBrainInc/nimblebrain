/**
 * The logic-less template a `kind: "tool"` target renders its input through.
 *
 * A Mustache subset and nothing more: `{{name}}` is replaced by a value, and
 * there are no sections, no inversions, no partials, no lambdas and no
 * filters. The whole vocabulary is four names — `title`, `body`, `subject` and
 * `link.resource` — resolved from the notification's presentation block.
 *
 * **`data` is deliberately absent.** It is the emitting server's structured
 * payload and no runtime code reads a field of it, so there is nothing to
 * template out of. A route that needs a fifth name is a design question, not a
 * missing placeholder.
 *
 * **No escaping, because there is no markup.** Mustache's `{{ }}` / `{{{ }}}`
 * distinction exists to HTML-escape by default; here the output is a JSON
 * value handed to a tool's own input schema, so escaping for a syntax nobody
 * is in would corrupt an apostrophe in a subject line. The value is inserted
 * as text and the tool decides what text means.
 */

import {
  NOTIFICATION_PLACEHOLDERS,
  type NotificationPlaceholder,
} from "../tools/platform/schemas/notifications.ts";
import type { NotificationPresentation } from "./types.ts";

/**
 * Every `{{…}}` occurrence, however spaced.
 *
 * Shared with the write-time validator in `config.ts`, which refuses a name
 * this renderer would not resolve. One regex, because a validator that
 * recognised a form the renderer did not would pass a route that renders
 * literal braces into somebody's channel — the exact failure it exists to
 * prevent.
 */
export const PLACEHOLDER_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

const PLACEHOLDERS = new Set<string>(NOTIFICATION_PLACEHOLDERS);

/** What one render produced, and how much of it the runtime could not resolve. */
export interface RenderedInput {
  input: Record<string, unknown>;
  /**
   * Placeholders that named something outside the four. Each renders empty.
   *
   * Counted rather than refused: the write-time validator already refuses
   * them, so anything reaching here came off a record written by an older
   * version or edited by hand, and a background loop's options at that point
   * are to deliver something or nothing. Empty is the honest render — literal
   * braces in a Slack channel look like the connector wrote them.
   *
   * A *known* name whose value is absent (`{{body}}` on an item with no body)
   * is not a miss. It is the ordinary case, it renders empty by design, and
   * counting it would make the metric a measure of how many notifications have
   * short bodies.
   */
  misses: number;
}

/**
 * Render one target's stored input against one notification.
 *
 * Recursive over the whole structure, keys included: a `{{…}}` used as an
 * object key reaches the tool as literally as one used as a value, so both
 * sides are rendered. Non-string leaves (numbers, booleans, null) pass
 * through untouched — there is nothing in them to substitute.
 */
export function renderDeliverInput(
  input: Record<string, unknown> | undefined,
  presentation: NotificationPresentation,
): RenderedInput {
  if (input === undefined) return { input: {}, misses: 0 };
  const state = { misses: 0 };
  const values = placeholderValues(presentation);
  return {
    input: renderValue(input, values, state) as Record<string, unknown>,
    misses: state.misses,
  };
}

/** The four names, resolved. An absent optional renders as the empty string. */
function placeholderValues(
  presentation: NotificationPresentation,
): Readonly<Record<NotificationPlaceholder, string>> {
  return {
    title: presentation.title,
    body: presentation.body ?? "",
    subject: presentation.subject ?? "",
    "link.resource": presentation.link?.resource ?? "",
  };
}

function renderValue(
  value: unknown,
  values: Readonly<Record<NotificationPlaceholder, string>>,
  state: { misses: number },
): unknown {
  if (typeof value === "string") return renderString(value, values, state);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, values, state));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[renderString(key, values, state)] = renderValue(item, values, state);
    }
    return out;
  }
  return value;
}

function renderString(
  text: string,
  values: Readonly<Record<NotificationPlaceholder, string>>,
  state: { misses: number },
): string {
  // `replace` with a global regex resets `lastIndex` itself, so the shared
  // pattern is safe to reuse across calls; `matchAll` on the same object would
  // not be.
  return text.replace(PLACEHOLDER_RE, (_whole, rawName: string) => {
    if (!PLACEHOLDERS.has(rawName)) {
      state.misses++;
      return "";
    }
    return values[rawName as NotificationPlaceholder];
  });
}
