/**
 * The Python server SDK (`packages/server-sdk-py`, `add_server_card`) serves the
 * MCP Server Card this runtime reads when a server is added by URL (ADR-0065).
 * The SDK's suite asserts its probe server serves exactly the `card` in
 * `tests/fixtures/server_card.json`, at `card_path` with `media_type`; this one
 * asserts the runtime requests that path with that media type and reads that
 * card as `host_reads`. A field either side renames fails one of the two.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseServerCard,
  SERVER_CARD_MEDIA_TYPE,
  serverCardUrl,
} from "../../../src/connectors/runtime/server-card.ts";

const FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../packages/server-sdk-py/tests/fixtures/server_card.json"),
    "utf8",
  ),
);

describe("the card the server SDK serves", () => {
  test("is requested where the SDK serves it, with the SDK's media type", () => {
    expect(serverCardUrl(new URL(FIXTURE.server_url)).pathname).toBe(FIXTURE.card_path);
    expect(SERVER_CARD_MEDIA_TYPE).toBe(FIXTURE.media_type);
  });

  test("reads as the fixture's host_reads", () => {
    expect(parseServerCard(FIXTURE.card)).toEqual(FIXTURE.host_reads);
  });
});
