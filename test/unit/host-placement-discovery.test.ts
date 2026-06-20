import { describe, expect, test } from "bun:test";
import { sanitizePlacements } from "../../src/bundles/defaults.ts";
import type { PlacementDeclaration } from "../../src/bundles/types.ts";
import type { ServerDetail } from "../../src/connectors/server-detail.ts";
import { serverDetailToCatalogEntry } from "../../src/registries/projection.ts";
import { PlacementRegistry } from "../../src/runtime/placement-registry.ts";

// A fleet connector ServerDetail with a host-placement _meta block, mirroring
// the operator catalog (platform.yaml) bridge shape for People.
function fleetDetail(host?: unknown): ServerDetail {
  return {
    name: "ai.nimblebrain.people/mcp",
    title: "People",
    description: "Contacts & orgs",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: "http://mcp-people.mcp-shared.svc/mcp" }],
    _meta: {
      "ai.nimblebrain/connector": { auth: "provider", interactive: true },
      ...(host !== undefined ? { "ai.nimblebrain/host": host } : {}),
    },
  } as ServerDetail;
}

describe("serverDetailToCatalogEntry — host UI from ServerDetail._meta", () => {
  test("a fleet ServerDetail._meta host block surfaces ui.placements", () => {
    const entry = serverDetailToCatalogEntry(
      fleetDetail({
        host_version: "1.1",
        name: "People",
        icon: "users",
        placements: [
          { slot: "sidebar.apps", resourceUri: "ui://people/main", label: "People" },
        ],
      }),
    );
    expect(entry?.ui).toEqual({
      name: "People",
      icon: "users",
      placements: [
        { slot: "sidebar.apps", resourceUri: "ui://people/main", label: "People" },
      ],
    });
  });

  test("no host block → no ui (connector still projects, tools-only)", () => {
    const entry = serverDetailToCatalogEntry(fleetDetail());
    expect(entry).not.toBeNull();
    expect(entry?.ui).toBeUndefined();
  });

  test("host block without a name → no ui (host needs a label to surface anything)", () => {
    const entry = serverDetailToCatalogEntry(
      fleetDetail({ host_version: "1.0", placements: [{ slot: "main", resourceUri: "ui://x/y" }] }),
    );
    expect(entry?.ui).toBeUndefined();
  });
});

describe("serverDetailToCatalogEntry — interactive badge is derived, not trusted", () => {
  // ServerDetail whose connector meta does NOT set an explicit `interactive` flag,
  // so the badge must come from whether the connector actually renders UI.
  function detail(host?: unknown, connectorInteractive?: boolean): ServerDetail {
    return {
      name: "ai.nimblebrain.people/mcp",
      title: "People",
      description: "Contacts & orgs",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "http://mcp-people.mcp-shared.svc/mcp" }],
      _meta: {
        "ai.nimblebrain/connector": {
          auth: "provider",
          ...(connectorInteractive !== undefined ? { interactive: connectorInteractive } : {}),
        },
        ...(host !== undefined ? { "ai.nimblebrain/host": host } : {}),
      },
    } as ServerDetail;
  }
  const withApp = { host_version: "1.1", name: "People", placements: [{ slot: "sidebar.apps", resourceUri: "ui://people/main", label: "People" }] };

  test("host placements present, no explicit flag → interactive (the People drift fix)", () => {
    expect(serverDetailToCatalogEntry(detail(withApp))?.interactive).toBe(true);
  });

  test("explicit interactive:false but a placed app → still interactive (placements win)", () => {
    expect(serverDetailToCatalogEntry(detail(withApp, false))?.interactive).toBe(true);
  });

  test("no UI at all (no placements, no flag) → no badge", () => {
    expect(serverDetailToCatalogEntry(detail())?.interactive).toBeUndefined();
  });

  test("explicit interactive:true with no placements → interactive (tool-widget case)", () => {
    expect(serverDetailToCatalogEntry(detail(undefined, true))?.interactive).toBe(true);
  });
});

describe("registration sanitizes before the registry (install AND boot paths)", () => {
  // Both registration sites — install (lifecycle.registerPlacements) and boot
  // (runtime.ts workspace loop) — must sanitize before PlacementRegistry.register.
  // The earlier gap: placements persist RAW on the BundleRef, so a spoof dropped
  // at install would re-register verbatim at boot. This pins the shared contract:
  // sanitize → register → read-back never lets a foreign authority through.
  function registerLikeRuntime(reg: PlacementRegistry, server: string, raw: PlacementDeclaration[], wsId: string) {
    const safe = sanitizePlacements(raw);
    if (safe.length > 0) reg.register(server, safe, wsId);
  }

  test("a foreign-authority spoof never reaches the registry; the legit placement does", () => {
    const reg = new PlacementRegistry();
    // People's RAW host meta carries its own app + a spoof at another authority.
    registerLikeRuntime(
      reg,
      "ai.nimblebrain.people/mcp",
      [
        { slot: "sidebar.apps", resourceUri: "ui://people/main", label: "People" },
        { slot: "sidebar", resourceUri: "ui://home/dashboard", label: "Home (spoof)" },
      ],
      "ws_hq",
    );
    const entries = reg.forWorkspace("ws_hq");
    expect(entries.map((e) => e.resourceUri)).toEqual(["ui://people/main"]);
    // the spoof at ui://home/* is absent — could not shadow a host surface
    expect(entries.some((e) => e.resourceUri.startsWith("ui://home/"))).toBe(false);
  });

  test("an all-malformed set registers nothing (connector still works tools-only)", () => {
    const reg = new PlacementRegistry();
    registerLikeRuntime(
      reg,
      "ai.nimblebrain.people/mcp",
      [{ slot: "main", resourceUri: "https://evil/x" }, { slot: "main", resourceUri: "ui://" }],
      "ws_hq",
    );
    expect(reg.forWorkspace("ws_hq")).toEqual([]);
  });
});

describe("sanitizePlacements — server-declared chrome is untrusted", () => {
  test("keeps a well-formed own-namespace placement", () => {
    const out = sanitizePlacements([
      { slot: "sidebar.apps", resourceUri: "ui://people/main", label: "People" },
    ]);
    expect(out).toEqual([
      { slot: "sidebar.apps", resourceUri: "ui://people/main", label: "People" },
    ]);
  });

  test("drops non-ui:// schemes (can't point host chrome at http/file)", () => {
    expect(sanitizePlacements([{ slot: "main", resourceUri: "https://evil.example/x" }])).toEqual([]);
    expect(sanitizePlacements([{ slot: "main", resourceUri: "file:///etc/passwd" }])).toEqual([]);
  });

  test("drops path traversal and malformed ui:// uris", () => {
    expect(sanitizePlacements([{ slot: "main", resourceUri: "ui://people/../secret" }])).toEqual([]);
    expect(sanitizePlacements([{ slot: "main", resourceUri: "ui://people" }])).toEqual([]); // no path
    expect(sanitizePlacements([{ slot: "main", resourceUri: "ui://" }])).toEqual([]);
  });

  test("anti-spoof: a server may not mix a second ui:// authority", () => {
    const out = sanitizePlacements([
      { slot: "sidebar.apps", resourceUri: "ui://people/main", label: "People" },
      { slot: "sidebar.apps", resourceUri: "ui://home/dashboard", label: "Home (spoof)" },
    ]);
    // first authority wins; the foreign-authority placement is dropped
    expect(out).toEqual([
      { slot: "sidebar.apps", resourceUri: "ui://people/main", label: "People" },
    ]);
  });

  test("drops placements with an empty/non-string slot", () => {
    expect(
      sanitizePlacements([
        { slot: "", resourceUri: "ui://people/main" },
        // @ts-expect-error — exercising untrusted runtime input
        { slot: 123, resourceUri: "ui://people/main" },
      ]),
    ).toEqual([]);
  });

  test("truncates overlong label/icon, keeps the placement", () => {
    const long = "x".repeat(500);
    const out = sanitizePlacements([
      { slot: "sidebar.apps", resourceUri: "ui://people/main", label: long, icon: long },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label?.length).toBe(128);
    expect(out[0].icon?.length).toBe(128);
  });

  test("malformed / missing input → empty array, never throws", () => {
    expect(sanitizePlacements(undefined)).toEqual([]);
    expect(sanitizePlacements([])).toEqual([]);
    // @ts-expect-error — exercising untrusted runtime input
    expect(() => sanitizePlacements([null, undefined, {}, { slot: "main" }])).not.toThrow();
    // @ts-expect-error — exercising untrusted runtime input
    expect(sanitizePlacements([null, undefined, {}, { slot: "main" }])).toEqual([]);
  });
});
