import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

export const HomeActivityInput = Type.Object({
  since: Type.Optional(Type.String({ description: "ISO timestamp. Default: 24 hours ago." })),
  until: Type.Optional(Type.String({ description: "ISO timestamp. Default: now." })),
  category: Type.Optional(
    StringEnum(["conversations", "connectors", "tools", "errors"] as const, {
      description: "Filter to one category.",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max items per category. Default: 50." })),
});
export type HomeActivityInput = Static<typeof HomeActivityInput>;

// ── Briefing output ────────────────────────────────────────────────────────
//
// Canonical contract for the `nb__briefing` tool's structured output. Per the
// output-schema convention these are type-only (we don't wire-validate
// outputs): `src/services/home-types.ts` re-exports them for the backend, and
// `bun run codegen` emits them to `web/src/_generated/platform-schemas/home.d.ts`
// for the web briefing surface. Single source of truth — do not hand-redeclare
// on either side.

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
