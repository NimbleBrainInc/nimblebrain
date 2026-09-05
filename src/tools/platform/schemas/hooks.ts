import { Type } from "@sinclair/typebox";

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
