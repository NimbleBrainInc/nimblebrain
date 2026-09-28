// ── Briefing output ────────────────────────────────────────────────────────
//
// Canonical contract for the `nb__briefing` tool's structured output. Per the
// output-schema convention these are type-only (we don't wire-validate
// outputs): the backend imports them from here, and `bun run codegen` emits
// them to `web/src/_generated/platform-schemas/home.d.ts` for the web briefing
// surface. Single source of truth — do not hand-redeclare on either side.

/**
 * One facet of one app: `<count> <label>`, opening the app. Built from a count
 * the app's server returned over the `ai.nimblebrain/facets` extension; nothing
 * in it is generated. `label` and `count` are untrusted server data: render the
 * label as text and the count as a number.
 */
export interface BriefingItem {
  /** The app's display name. */
  app: string;
  /** The facet's name, stable within the app's server. */
  facet: string;
  /** The facet resource's `title`. */
  label: string;
  /** Things waiting, as the server counted them. 0 when `state` is `unavailable`. */
  count: number;
  /** The app's first placement route, or null when it has none. */
  route: string | null;
  /** `unavailable` when the read failed, timed out, or returned no valid count. */
  state: "ok" | "unavailable";
}

/**
 * Complete briefing output returned by `nb__briefing`. One per workspace,
 * shared by every member, so it carries nothing about the viewer. An item
 * whose count is zero is omitted; an empty `items` means nothing is waiting.
 */
export interface BriefingOutput {
  items: BriefingItem[];
  generated_at: string;
}
