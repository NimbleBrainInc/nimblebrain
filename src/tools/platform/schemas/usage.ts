import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

export const UsageReportInput = Type.Object({
  period: Type.Optional(
    StringEnum(["day", "week", "month", "all"] as const, {
      description: "Time period. Default: month.",
    }),
  ),
  from: Type.Optional(Type.String({ description: "Start date (YYYY-MM-DD). Overrides period." })),
  to: Type.Optional(Type.String({ description: "End date (YYYY-MM-DD). Default: today." })),
  groupBy: Type.Optional(
    StringEnum(["day", "conversation", "model"] as const, {
      description: "Group breakdown. Default: day.",
    }),
  ),
});
export type UsageReportInput = Static<typeof UsageReportInput>;
