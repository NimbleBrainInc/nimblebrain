import { type Static, Type } from "@sinclair/typebox";

/** No arguments: the workspace comes from the request, never from the caller. */
export const HooksListInput = Type.Object({}, { additionalProperties: false });

export const HooksRotateInput = Type.Object(
  {
    connector: Type.String({
      description: "Slugified server name of the connector whose stream is rotating.",
      pattern: "^[a-zA-Z0-9_-]+$",
    }),
    vendor: Type.String({
      description: "Vendor slug of the stream, as the connector declared it.",
      pattern: "^[a-zA-Z0-9_-]+$",
    }),
  },
  { required: ["connector", "vendor"], additionalProperties: false },
);

/**
 * One delivery URL, as the settings tab lists it. Read from the workspace
 * record, so it admits every registration that record has held: one written
 * before delivery ids existed has no address (`url: null`), and one never
 * rotated has no `rotatedAt`.
 */
export const HookWebhook = Type.Object({
  connector: Type.String({ description: "Slugified server name of the connector." }),
  vendor: Type.String({ description: "Vendor slug, as the connector declared it." }),
  route: Type.String({ description: "Path on the connector the delivery is forwarded to." }),
  url: Type.Union([Type.String(), Type.Null()], {
    description:
      "The full delivery URL. Null when the registration predates delivery ids; rotating mints one.",
  }),
  createdAt: Type.String({ description: "ISO timestamp of the first mint." }),
  rotatedAt: Type.Union([Type.String(), Type.Null()], {
    description: "ISO timestamp of the last rotation. Null before the first.",
  }),
  previousStillValid: Type.Boolean({
    description: "Whether the URL this one replaced is still inside its grace window.",
  }),
});
export type HookWebhook = Static<typeof HookWebhook>;

export const HooksListOutput = Type.Object({
  webhooks: Type.Array(HookWebhook),
  count: Type.Integer({ minimum: 0 }),
});
export type HooksListOutput = Static<typeof HooksListOutput>;

export const HooksRotateOutput = Type.Object({
  connector: Type.String(),
  vendor: Type.String(),
  url: Type.Union([Type.String(), Type.Null()], {
    description: "The new delivery URL, read back from the stored record.",
  }),
  registered: Type.Boolean({
    description:
      "Whether the connector accepted the new URL. False means the door admits it but the " +
      "vendor still delivers to the previous one, which the grace window holds open.",
  }),
  error: Type.Union([Type.String(), Type.Null()], {
    description: "Why the connector did not accept the new URL, when it did not.",
  }),
  previousStillValid: Type.Boolean({
    description: "Whether the URL this one replaced is still inside its grace window.",
  }),
});
export type HooksRotateOutput = Static<typeof HooksRotateOutput>;
