import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

export const HomeActivityInput = Type.Object({
  since: Type.Optional(Type.String({ description: "ISO timestamp. Default: 24 hours ago." })),
  until: Type.Optional(Type.String({ description: "ISO timestamp. Default: now." })),
  category: Type.Optional(
    StringEnum(["conversations", "bundles", "tools", "errors"] as const, {
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
// outputs): `src/services/home-types.ts` re-exports them for the backend
// (generator, cache, core-source), and `bun run codegen` emits them to
// `web/src/_generated/platform-schemas/home.d.ts` for the web briefing surface.
// Single source of truth — do not hand-redeclare on either side.

/** Dashboard state derived from briefing content. */
export type BriefingState = "empty" | "quiet" | "all-clear" | "normal" | "attention";

/**
 * Action attached to a briefing section. `type` discriminates the payload —
 * `navigate` uses `route`, `startChat` uses `prompt` — but both fields are
 * always present (null for the unused variant) because the LLM structured-
 * output schema requires every property. Consumers check `type` first.
 */
export interface BriefingAction {
  type: "navigate" | "startChat";
  label: string;
  /** Set on navigate actions; null on startChat. */
  route: string | null;
  /** Set on startChat actions; null on navigate. */
  prompt: string | null;
}

/** Individual briefing section — one line item under a category heading. */
export interface BriefingSection {
  id: string;
  text: string;
  type: "positive" | "neutral" | "warning";
  category: "recent" | "upcoming" | "attention";
  action?: BriefingAction;
}

/** Complete briefing output returned by `nb__briefing`. */
export interface BriefingOutput {
  greeting: string;
  date: string;
  lede: string;
  sections: BriefingSection[];
  state: BriefingState;
  generated_at: string;
  cached: boolean;
}
