/**
 * The `notifications` block a server declares, and how it reaches the install
 * path.
 *
 * Same tolerance as `parseHookDeclarations` (see `hooks-declaration.test.ts`):
 * a malformed block is dropped, never thrown, so a typo costs the outbox
 * rather than the install. The one thing this parser is strict about is the
 * resource URI, because the runtime appends `{?cursor,maxEvents,maxAgeMs}` to
 * it — a query string a server supplied would be silently overwritten.
 */

import { describe, expect, test } from "bun:test";
import type { HostManifestMeta } from "../../../src/bundles/types.ts";
import {
  isOutboxResource,
  parseNotificationsDeclaration,
} from "../../../src/notifications/declaration.ts";
import { serverDetailToCatalogEntry } from "../../../src/registries/projection.ts";
import {
  isReservedResourceScheme,
  RESERVED_RESOURCE_SCHEMES,
} from "../../../src/tools/resource-schemes.ts";
import type { ServerDetail } from "../../../src/connectors/server-detail.ts";

/** A `HostManifestMeta` carrying whatever the caller wants under `notifications`. */
function metaWith(notifications: unknown): HostManifestMeta {
  return { host_version: "1.3", notifications } as unknown as HostManifestMeta;
}

describe("parseNotificationsDeclaration", () => {
  test("reads a well-formed block", () => {
    const decl = parseNotificationsDeclaration(
      metaWith({ resource: "acme://notifications", description: "Domain lifecycle." }),
    );
    expect(decl).toEqual({ resource: "acme://notifications", description: "Domain lifecycle." });
  });

  test("description is optional", () => {
    expect(parseNotificationsDeclaration(metaWith({ resource: "acme://notifications" }))).toEqual({
      resource: "acme://notifications",
    });
  });

  test.each([...RESERVED_RESOURCE_SCHEMES])(
    "refuses an outbox declared under the reserved %s:// scheme",
    (scheme) => {
      // One resource cannot mean two things to the same reader: the runtime
      // would poll it as an outbox and resolve it as a skill / app surface /
      // overlay, and whichever won would be an accident of ordering.
      expect(
        parseNotificationsDeclaration(metaWith({ resource: `${scheme}://acme/notifications` })),
      ).toBeUndefined();
    },
  );

  test("a bare string with no scheme is not a reserved one", () => {
    // `indexOf(":")` is -1 with no colon and `slice(0, -1)` would drop the last
    // character, so an unguarded predicate answers for `skill` when asked about
    // `skills`. Nothing reaches it that way today — `isOutboxResource` runs
    // first and requires a colon — but the predicate is exported and total.
    expect(isReservedResourceScheme("skills")).toBe(false);
    expect(isReservedResourceScheme("instructionsX")).toBe(false);
    expect(isReservedResourceScheme("apps")).toBe(false);
  });

  test("refuses a reserved scheme whatever its case", () => {
    // RFC 3986 schemes are case-insensitive, so refusing only the lowercase
    // spelling would be a check that reads as one without being one.
    expect(
      parseNotificationsDeclaration(metaWith({ resource: "UI://acme/notifications" })),
    ).toBeUndefined();
  });

  test("a server's own namespace is what an outbox uses, at any path", () => {
    // Scheme and path are both the server's; the runtime parses neither. A
    // path other than `notifications` is as valid.
    expect(parseNotificationsDeclaration(metaWith({ resource: "acme://inbox" }))).toEqual({
      resource: "acme://inbox",
    });
  });

  test("no block, no declaration", () => {
    expect(parseNotificationsDeclaration({ host_version: "1.0" })).toBeUndefined();
    expect(parseNotificationsDeclaration(undefined)).toBeUndefined();
  });

  test("a malformed block is dropped, never thrown", () => {
    for (const bad of [
      "acme://notifications",
      [{ resource: "acme://notifications" }],
      {},
      { resource: 7 },
      { resource: "" },
      { resource: "notifications" },
      { resource: "acme://notifications?cursor=x" },
      { resource: "acme://notifications#top" },
      { resource: `acme://${"x".repeat(600)}` },
    ]) {
      expect(() => parseNotificationsDeclaration(metaWith(bad))).not.toThrow();
      expect(parseNotificationsDeclaration(metaWith(bad))).toBeUndefined();
    }
  });

  test("a non-string description is dropped without dropping the declaration", () => {
    expect(
      parseNotificationsDeclaration(metaWith({ resource: "acme://x", description: 42 })),
    ).toEqual({ resource: "acme://x" });
  });
});

describe("isOutboxResource", () => {
  test("accepts a URI with a scheme and no query", () => {
    expect(isOutboxResource("acme://notifications")).toBe(true);
    expect(isOutboxResource("https://acme.test/outbox")).toBe(true);
  });

  test("refuses what the runtime cannot template", () => {
    expect(isOutboxResource("/outbox")).toBe(false);
    expect(isOutboxResource("acme://outbox?cursor=1")).toBe(false);
    expect(isOutboxResource("acme://outbox#frag")).toBe(false);
    expect(isOutboxResource("")).toBe(false);
  });
});

describe("the catalog carries the declaration to the install path", () => {
  /** A `ServerDetail` with the host extension the operator published. */
  function detail(hostMeta: Record<string, unknown>): ServerDetail {
    return {
      name: "test.acme/mcp",
      description: "Acme",
      remotes: [{ type: "streamable-http", url: "https://acme.test/mcp" }],
      _meta: { "ai.nimblebrain/host": hostMeta },
    } as unknown as ServerDetail;
  }

  test("a declared outbox lands on the catalog entry", () => {
    const entry = serverDetailToCatalogEntry(
      detail({ host_version: "1.3", notifications: { resource: "acme://notifications" } }),
    );
    expect(entry?.notifications).toEqual({ resource: "acme://notifications" });
  });

  test("an entry that declares none carries no field at all", () => {
    const entry = serverDetailToCatalogEntry(detail({ host_version: "1.0" }));
    expect(entry).not.toBeNull();
    expect("notifications" in (entry as object)).toBe(false);
  });

  test("a malformed declaration drops the outbox, not the entry", () => {
    const entry = serverDetailToCatalogEntry(
      detail({ host_version: "1.3", notifications: { resource: "acme://x?cursor=1" } }),
    );
    expect(entry).not.toBeNull();
    expect(entry?.notifications).toBeUndefined();
  });
});

/**
 * The published schema and this module state one rule, so they have to agree.
 *
 * `host-manifest.schema.json` is what a bundle author validates against before
 * shipping — it is the only place the rule can reach the one person who can fix
 * a bad declaration. `isOutboxResource` is what the runtime enforces at install
 * time, where a failure is a debug log and an outbox that is simply never
 * polled. Two statements of one rule, on opposite sides of the moment it
 * matters, is exactly the shape that drifts; these pin them together.
 */
describe("the schema and the parser state the same rule", () => {
  const schema = require("../../../src/bundles/schemas/host-manifest.schema.json");
  const resource = schema.$defs.NotificationsDeclaration.properties.resource;

  test("the reserved-scheme constraint names exactly the schemes the runtime resolves", () => {
    // Derived, not eyeballed: the schema carries a copy of a set that grows —
    // it went from five to six when `app://` was added — so the copy is pinned
    // to the constant rather than trusted to be re-read.
    const spelled = resource.not.pattern.replace(/^\^\(\?:/, "").replace(/\):$/, "").split("|");
    expect(spelled.sort()).toEqual([...RESERVED_RESOURCE_SCHEMES].sort());
  });

  test("the schema's pattern admits exactly what the parser admits", () => {
    const pattern = new RegExp(resource.pattern);
    const corpus = [
      "acme://notifications",
      "acme://inbox",
      "acme:notifications",
      "acme:/notifications",
      "po://notifications",
      "urn:x:y",
      "ACME://x",
      "acme://a/b",
      "notifications",
      "://notifications",
      "9lives://x",
      "acme_x://notifications",
      "acme://notifications?since=1",
      "acme://notifications#top",
      "ac?me://notifications",
      "acme://note ifications",
      "acme://a\tb",
      "",
    ];
    for (const candidate of corpus) {
      // maxLength is the schema's alone; the parser's length check is the same
      // number and is not what this compares.
      expect({ candidate, schema: pattern.test(candidate) }).toEqual({
        candidate,
        schema: isOutboxResource(candidate),
      });
    }
  });

  test("a URI over the schema's maxLength is refused by the parser too", () => {
    expect(resource.maxLength).toBe(512);
    const fill = resource.maxLength - "acme://".length;
    expect(isOutboxResource(`acme://${"a".repeat(fill)}`)).toBe(true);
    expect(isOutboxResource(`acme://${"a".repeat(fill + 1)}`)).toBe(false);
  });
});
