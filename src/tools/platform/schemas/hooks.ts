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
    confirm: Type.String({
      description:
        "Must equal the vendor slug. A rotation retires the URL the vendor is " +
        "delivering to once its grace window closes, so the caller names what it is " +
        "about to disrupt rather than confirming a generic prompt.",
    }),
  },
  { required: ["connector", "vendor", "confirm"], additionalProperties: false },
);
