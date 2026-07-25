/**
 * The 64-character wire-name budget.
 *
 * Tool names reach the model as `ws_<id>-<source>__<tool>`. OpenAI-compatible
 * chat-completions APIs constrain function names to `[a-zA-Z0-9_-]{1,64}`;
 * Anthropic allows 128. Because every tenant ran Claude, nothing enforced the
 * tighter bound and names grew past it unnoticed. Pointing a tenant's
 * `models.default` at an OpenAI-compatible provider then broke every workspace
 * tool call: the model dropped the prefix it could not reproduce, the bare name
 * routed to the identity door, and `UnknownIdentitySource` came back for every
 * call except the genuinely-bare `conversations__*`.
 *
 * This suite is the guard. It asserts the budget over the three inputs that
 * compose a wire name, so a regression fails here rather than silently in a
 * non-Anthropic tenant.
 *
 * It is deliberately provider-shaped, not implementation-shaped: it pins the
 * externally-imposed limit, so it stays valid whether the fix shortens
 * `serverName`, drops the workspace segment, or aliases at the boundary.
 */

import { describe, expect, test } from "bun:test";
import { slugifyServerName } from "../../../src/bundles/paths.ts";
import { namespacedToolName } from "../../../src/tools/namespace.ts";

/**
 * The hard ceiling. OpenAI's function-name schema is
 * `^[a-zA-Z0-9_-]{1,64}$`, and every OpenAI-compatible gateway inherits it.
 * Anthropic's 128 is the looser case and is not what we design against.
 */
const WIRE_NAME_MAX = 64;

/** The provider-side alphabet. A name outside it is rejected at registration. */
const WIRE_NAME_ALPHABET = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Representative canonical server names in the reverse-DNS form
 * `ServerDetail.name` carries. Generic vendors deliberately — the property
 * under test is length arithmetic, not any particular catalog entry.
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

/** A personal workspace id under today's derived format: `ws_user_` + a ULID user id. */
const DERIVED_PERSONAL_WS_ID = "ws_user_user_01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** An opaque workspace id under today's `generateWorkspaceId` format. */
const OPAQUE_WS_ID = "ws_0123456789abcdef";

describe("wire-name budget", () => {
  test("the provider alphabet admits the shapes we construct", () => {
    const name = namespacedToolName(OPAQUE_WS_ID, `${slugifyServerName("ai.example/web-mcp")}__search`);
    expect(name).toMatch(WIRE_NAME_ALPHABET);
  });

  test("every workspace tool name fits the 64-character budget", () => {
    const over: string[] = [];

    for (const wsId of [DERIVED_PERSONAL_WS_ID, OPAQUE_WS_ID]) {
      for (const canonical of CANONICAL_SERVER_NAMES) {
        for (const tool of TOOL_NAMES) {
          const wire = namespacedToolName(wsId, `${slugifyServerName(canonical)}__${tool}`);
          if (wire.length > WIRE_NAME_MAX) over.push(`${wire.length}  ${wire}`);
        }
      }
    }

    expect(over).toEqual([]);
  });

  test("the source segment alone leaves room for a tool name", () => {
    // Whatever the source segment costs, a tool name has to fit beside it.
    // `find_or_create_organization` (27) is the longest observed; require that
    // the source segment plus separators never crowds it out.
    const longestTool = TOOL_NAMES.reduce((a, b) => (a.length >= b.length ? a : b));
    const over: string[] = [];

    for (const canonical of CANONICAL_SERVER_NAMES) {
      const source = slugifyServerName(canonical);
      const bare = `${source}__${longestTool}`;
      if (bare.length > WIRE_NAME_MAX) over.push(`${bare.length}  ${bare}`);
    }

    expect(over).toEqual([]);
  });

  test("slugified server names are unique across the catalog", () => {
    // Uniqueness is required within an owner (permissions and credentials are
    // stored per user / per workspace) and across the curated catalog, which is
    // keyed by slug. It is NOT required globally, so a shortening scheme only
    // has to hold this weaker property.
    const slugs = CANONICAL_SERVER_NAMES.map(slugifyServerName);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
