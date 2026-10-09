import { describe, expect, it } from "bun:test";
import type { InputRequests } from "@modelcontextprotocol/server";
import { argsDigest, relayInputRequests } from "../../../src/api/mcp-input-relay.ts";

function urlRequest(url: string): InputRequests {
  return {
    confirm: {
      method: "elicitation/create",
      params: { mode: "url", message: "Confirm the send", elicitationId: "e1", url },
    },
  };
}

describe("relayInputRequests", () => {
  it("names the connector in a URL-mode message and keeps an absolute url", () => {
    const relayed = relayInputRequests(urlRequest("https://mail.example.com/confirm/1"), "Mail");
    expect(relayed.confirm).toEqual({
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Mail: Confirm the send",
        elicitationId: "e1",
        url: "https://mail.example.com/confirm/1",
      },
    });
  });

  it("names the connector in a form-mode message", () => {
    const relayed = relayInputRequests(
      {
        ask: {
          method: "elicitation/create",
          params: {
            message: "Which list?",
            requestedSchema: { type: "object", properties: { list: { type: "string" } } },
          },
        },
      },
      "Mail",
    );
    const ask = relayed.ask as { params: { message: string; requestedSchema: unknown } };
    expect(ask.params.message).toBe("Mail: Which list?");
    expect(ask.params.requestedSchema).toEqual({
      type: "object",
      properties: { list: { type: "string" } },
    });
  });

  it("passes sampling and roots requests through as they are", () => {
    const requests: InputRequests = {
      roots: { method: "roots/list" },
      sample: {
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: "hi" } }],
          maxTokens: 10,
        },
      },
    };
    expect(relayInputRequests(requests, "Mail")).toEqual(requests);
  });

  it("relays a URL-mode url exactly as given, a relative one included", () => {
    const relayed = relayInputRequests(urlRequest("/confirm/1"), "Mail");
    expect((relayed.confirm as { params: { url: string } }).params.url).toBe("/confirm/1");
  });
});

describe("argsDigest", () => {
  it("is the same whatever the key order", () => {
    expect(argsDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(argsDigest({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("differs for other arguments", () => {
    expect(argsDigest({ to: "a@example.com" })).not.toBe(argsDigest({ to: "b@example.com" }));
  });

  it("treats no arguments as an empty object", () => {
    expect(argsDigest(undefined)).toBe(argsDigest({}));
  });
});
