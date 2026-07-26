/**
 * The shape of a wire tool name.
 *
 * Tool names reach the model as bare `<source>__<tool>`, and personal connectors
 * as `my-<source>__<tool>`. This suite pins the properties dispatch actually
 * depends on: that the source segment round-trips through the `__` split, and
 * that a personal connector stays distinguishable from a workspace source of the
 * same name.
 *
 * **On length.** An earlier version of this file asserted a hard 64-character
 * budget, taken from OpenAI's documented function-name schema
 * (`^[a-zA-Z0-9_-]{1,64}$`), on the theory that it explained why a Nebius-hosted
 * model began dropping the `ws_<id>-` prefix. Production says otherwise: that
 * provider accepted and correctly dispatched an 80-character name, and in the
 * same conversation the 50-character namespaced form succeeded while the
 * 10-character bare form failed. Length was never the variable. The prefix was
 * dropped because it was 39 opaque characters the model had no way to derive and
 * no reason to carry — so the fix was removing it, not shortening it.
 *
 * No length assertion is made here, because none is known to bind. The alphabet
 * IS asserted: every provider constrains the character set, and a name outside it
 * is rejected at registration rather than silently truncated.
 */

import { describe, expect, test } from "bun:test";
import { slugifyServerName } from "../../../src/bundles/paths.ts";
import { personalConnectorWireName } from "../../../src/tools/identity-sources.ts";

/** The provider-side alphabet, common to every vendor we target. */
const WIRE_NAME_ALPHABET = /^[a-zA-Z0-9_-]+$/;

/** Canonical `ServerDetail.name` values in the reverse-DNS form the catalog uses. */
const CANONICAL_SERVER_NAMES = [
  "ai.example/web-mcp",
  "ai.example/people-mcp",
  "ai.example/precision-outbound-mcp",
  "com.acme.crm/mcp",
  "dev.mpak.exampleinc/echo",
];

const TOOL_NAMES = ["search", "draft_email", "set_account_config", "find_or_create_organization"];

describe("wire tool-name shape", () => {
  test("a source segment round-trips through the first-`__` split", () => {
    // THE dispatch invariant: splitting `<source>__<tool>` on the FIRST `__`
    // must recover the source. That requires a source to contain no `__`. It
    // does NOT require a source to contain no `_` — `precision_outbound` is a
    // live source name carrying one, and `precision_outbound__create_campaign`
    // splits correctly.
    const sources = [
      ...CANONICAL_SERVER_NAMES.map(slugifyServerName),
      "precision_outbound",
      "ai-bassethound-mcp",
    ];

    for (const source of sources) {
      expect(source).not.toInclude("__");
      for (const tool of TOOL_NAMES) {
        const wire = `${source}__${tool}`;
        const sep = wire.indexOf("__");
        expect(wire.slice(0, sep)).toBe(source);
        expect(wire.slice(sep + 2)).toBe(tool);
      }
    }
  });

  test("slugified names use only the kebab alphabet", () => {
    // Narrower than the round-trip rule, and true: names this function produces
    // carry no underscore at all, which is what guarantees the round-trip for
    // every catalog-installed source. It says nothing about sources registered
    // by other paths.
    for (const canonical of [...CANONICAL_SERVER_NAMES, "com.acme/my_weird_name", "io.foo/a__b"]) {
      expect(slugifyServerName(canonical)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("every wire name is in the provider alphabet", () => {
    for (const canonical of CANONICAL_SERVER_NAMES) {
      const source = slugifyServerName(canonical);
      for (const tool of TOOL_NAMES) {
        expect(`${source}__${tool}`).toMatch(WIRE_NAME_ALPHABET);
        expect(`${personalConnectorWireName(source)}__${tool}`).toMatch(WIRE_NAME_ALPHABET);
      }
    }
  });

  test("the personal marker keeps a connector distinguishable from a workspace source", () => {
    // The one disambiguation the wire name still has to carry. A workspace
    // `gmail` and the caller's personal `gmail` are different credentials, and
    // with workspace names bare only the marker separates them. Install-time
    // checks cannot close this: the guard sees only the caller's own connectors,
    // never another workspace member's.
    const workspace = slugifyServerName("com.google/gmail");
    const personal = personalConnectorWireName(workspace);
    expect(personal).not.toBe(workspace);
    expect(personal.startsWith(workspace)).toBe(false);
  });
});
