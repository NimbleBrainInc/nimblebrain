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
