import { describe, expect, it } from "bun:test";
import type { FetchLike } from "@modelcontextprotocol/client";
import { createCredentialRequiredFetch } from "../../src/tools/credential-required-fetch.ts";

/**
 * The fetch that keeps an OAuth-only connection from sending the server a
 * request without a token. Against a real server that serves discovery
 * anonymously: `test/integration/mcp-source-credential-required.test.ts`.
 */

const SERVER = new URL("https://mcp.example.com/mcp/v1");

function recording() {
  const sent: string[] = [];
  const inner: FetchLike = async (input) => {
    sent.push(input.toString());
    return new Response("{}", { status: 200 });
  };
  return { sent, fetch: createCredentialRequiredFetch(inner, SERVER) };
}

describe("createCredentialRequiredFetch", () => {
  it("test_tokenless_request_to_the_server_is_answered_401_and_not_sent", async () => {
    const { sent, fetch } = recording();

    const response = await fetch(new URL(SERVER.href), {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: "{}",
    });

    expect(response.status).toBe(401);
    // No resource_metadata hint: the SDK discovers it at the path-aware well-known.
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("test_tokenless_request_to_the_server_by_string_url_is_answered_401", async () => {
    const { sent, fetch } = recording();

    const response = await fetch(SERVER.href, { method: "GET" });

    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("test_request_carrying_a_token_goes_to_the_server_in_every_header_form", async () => {
    const { sent, fetch } = recording();
    const forms: RequestInit["headers"][] = [
      new Headers({ Authorization: "Bearer at_expired" }),
      { authorization: "Bearer at_expired" },
      [["AUTHORIZATION", "Bearer at_expired"]],
    ];

    for (const headers of forms) {
      expect((await fetch(SERVER, { method: "POST", headers })).status).toBe(200);
    }

    expect(sent).toEqual([SERVER.href, SERVER.href, SERVER.href]);
  });

  it("test_tokenless_requests_to_other_urls_pass_through", async () => {
    const { sent, fetch } = recording();
    const others = [
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/v1",
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/register",
      "https://auth.example.com/token",
      "https://mcp.example.com/mcp/v1/other",
    ];

    for (const url of others) {
      expect((await fetch(url, { method: "POST" })).status).toBe(200);
    }

    expect(sent).toEqual(others);
  });
});
