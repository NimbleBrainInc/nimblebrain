/**
 * The 64-character wire-name budget.
 *
 * Tool names reach the model as bare `<source>__<tool>`, and personal connectors
 * as `my-<source>__<tool>`. OpenAI-compatible chat-completions APIs constrain
 * function names to `[a-zA-Z0-9_-]{1,64}`; Anthropic allows 128. Because every
 * tenant ran Claude, nothing enforced the tighter bound and names grew past it
 * unnoticed — they carried a `ws_<id>-` prefix repeating the session's own
 * workspace on every tool. Pointing a tenant's `models.default` at an
 * OpenAI-compatible provider then broke every workspace tool call: the model
 * dropped the prefix it could not reproduce, the bare name routed to the
 * identity door, and `UnknownIdentitySource` came back for every call except the
 * genuinely-bare `conversations__*`.
 *
 * This suite is the guard. It pins the externally-imposed limit rather than any
 * particular naming scheme, so it stays valid as the source segment shortens.
 */

import { describe, expect, test } from "bun:test";
import { shortServerName, slugifyServerName } from "../../../src/bundles/paths.ts";
import { personalConnectorWireName } from "../../../src/tools/identity-sources.ts";

/**
 * The hard ceiling. OpenAI's function-name schema is `^[a-zA-Z0-9_-]{1,64}$`,
 * and every OpenAI-compatible gateway inherits it. Anthropic's 128 is the looser
 * case and is not what we design against.
 */
const WIRE_NAME_MAX = 64;

/** The provider-side alphabet. A name outside it is rejected at registration. */
const WIRE_NAME_ALPHABET = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Representative canonical server names in the reverse-DNS form
 * `ServerDetail.name` carries. Generic vendors deliberately — the property under
 * test is length arithmetic, not any particular catalog entry.
 */
const CANONICAL_SERVER_NAMES = [
  "ai.example/web-mcp",
  "ai.example/people-mcp",
  "ai.example/precision-outbound-mcp",
  "com.acme.crm/mcp",
  "dev.mpak.exampleinc/echo",
];

/** The longest tool names such servers publish. */
const TOOL_NAMES = [
  "search",
  "draft_email",
  "set_account_config",
  "find_or_create_organization",
];

/** Every wire name a workspace source and a personal connector can produce. */
function wireNames(): string[] {
  const names: string[] = [];
  for (const canonical of CANONICAL_SERVER_NAMES) {
    const source = shortServerName(canonical);
    for (const tool of TOOL_NAMES) {
      names.push(`${source}__${tool}`);
      names.push(`${personalConnectorWireName(source)}__${tool}`);
    }
  }
  return names;
}

describe("wire-name budget", () => {
  test("every wire name fits the 64-character budget", () => {
    const over = wireNames()
      .filter((n) => n.length > WIRE_NAME_MAX)
      .map((n) => `${n.length}  ${n}`);
    expect(over).toEqual([]);
  });

  test("every wire name is in the provider alphabet", () => {
    const bad = wireNames().filter((n) => !WIRE_NAME_ALPHABET.test(n));
    expect(bad).toEqual([]);
  });

  test("the source segment never contains an underscore", () => {
    // This is what keeps `__` an unambiguous source/tool separator, and it is
    // why the mixed kebab/snake convention is load-bearing rather than untidy.
    // A source segment containing `__` would mis-split and route to the wrong
    // source; `slugifyServerName` maps every non-`[a-z0-9-]` character to `-`,
    // so it cannot happen — assert it so a future edit to that function cannot
    // quietly break dispatch.
    for (const canonical of [...CANONICAL_SERVER_NAMES, "com.acme/my_weird_name", "io.foo/a__b"]) {
      // Both names matter: `shortServerName` is what reaches the wire, and
      // `slugifyServerName` remains the storage identity and the legacy wire
      // form that resumed conversations still present.
      expect(shortServerName(canonical)).not.toInclude("_");
      expect(slugifyServerName(canonical)).not.toInclude("_");
    }
  });

  test("the personal marker keeps a connector distinguishable from a workspace source", () => {
    // A workspace `gmail` and the caller's personal `gmail` are different
    // credentials. With workspace names bare, only the marker separates them,
    // and install-time checks cannot prevent the collision: the guard sees only
    // the caller's own connectors, never another member's.
    const workspace = shortServerName("com.google/gmail");
    const personal = personalConnectorWireName(workspace);
    expect(personal).not.toBe(workspace);
    expect(personal.startsWith(workspace)).toBe(false);
  });

  test("slugified server names are unique across the catalog", () => {
    // Uniqueness is required within an owner (permissions and credentials are
    // stored per user / per workspace) and across the curated catalog, which is
    // keyed by slug. It is NOT required globally, so a future shortening scheme
    // only has to hold this weaker property.
    const slugs = CANONICAL_SERVER_NAMES.map(shortServerName);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
