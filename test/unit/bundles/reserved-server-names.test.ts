/**
 * The reserved-source-name gate.
 *
 * `validateServerName` is NOT install-only. `src/bundles/startup.ts` calls it on
 * every URL / named / local bundle start (three sites), so it re-validates
 * already-installed sources on every boot. Broadening the reserved set therefore
 * changes STARTABILITY for existing data, not just what a new install accepts —
 * a distinction the "no migration" claim (true of storage) does not cover.
 *
 * A source whose name is reserved is unreachable anyway: `routeToolCall`
 * consults the identity door first, so a workspace source named `conversations`
 * could never be called. Refusing to start it is the honest outcome; failing
 * silently would be worse. These tests pin the set so it cannot drift unnoticed.
 */

import { describe, expect, test } from "bun:test";
import {
  deriveServerName,
  isReservedServerName,
  slugifyServerName,
  validateServerName,
} from "../../../src/bundles/paths.ts";
import { PERSONAL_CONNECTOR_PREFIX } from "../../../src/tools/identity-sources.ts";

describe("reserved server names", () => {
  test("the predicate and the throwing form agree on every case", () => {
    // They were allowed to diverge once: the marker rule lived only in the
    // throwing form while `connector-tools` gated the identity-install boundary
    // on the predicate, so the rule was not enforced there.
    for (const name of [
      "nb",
      "conversations",
      "files",
      "automations",
      `${PERSONAL_CONNECTOR_PREFIX}gmail`,
      "crm",
      "gmail",
      "my-thing",
    ]) {
      let threw = false;
      try {
        validateServerName(name);
      } catch {
        threw = true;
      }
      expect(isReservedServerName(name)).toBe(threw);
    }
  });

  test("kernel identity sources are reserved", () => {
    // Reserved *because* workspace names went bare. While they carried a
    // `ws_<id>-` prefix a workspace `conversations` was distinguishable from the
    // identity one; now it would be silently shadowed.
    for (const name of ["conversations", "files", "automations"]) {
      expect(isReservedServerName(name)).toBe(true);
    }
  });

  test("the personal marker is reserved and lies outside slugify's image", () => {
    expect(isReservedServerName(`${PERSONAL_CONNECTOR_PREFIX}gmail`)).toBe(true);

    // The reservation is only safe because no catalog install can produce it.
    // A kebab marker would have been inside the alphabet and would have refused
    // legitimate connectors — `@my/thing` slugs to `my-thing`.
    for (const canonical of ["@my/thing", "my-notes/mcp", "my.company/mcp", "com.acme/my_weird"]) {
      expect(isReservedServerName(slugifyServerName(canonical))).toBe(false);
    }
  });

  test("an existing URL bundle can derive a newly-reserved name — it stops starting", () => {
    // The upgrade consequence, pinned rather than left implicit: `deriveServerName`
    // takes the last path segment, so these were installable before and refuse to
    // start after. Contained per-entry (siblings are unaffected), but an operator
    // sees only a stderr line, so the message has to say what to do.
    for (const url of ["https://example.com/conversations", "https://example.com/files"]) {
      const name = deriveServerName(url);
      expect(isReservedServerName(name)).toBe(true);
      expect(() => validateServerName(name)).toThrow(/reserved/);
    }
    expect(isReservedServerName(deriveServerName("https://example.com/crm"))).toBe(false);
  });

  test("an ordinary source name is not reserved", () => {
    for (const name of ["crm", "gmail", "granola", "ai-bassethound-mcp", "precision_outbound"]) {
      expect(isReservedServerName(name)).toBe(false);
      expect(() => validateServerName(name)).not.toThrow();
    }
  });
});
