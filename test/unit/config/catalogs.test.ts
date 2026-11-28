import { describe, expect, test } from "bun:test";
import {
  type CatalogConfig,
  defaultCatalogs,
  deriveCatalogName,
  resolveCatalogs,
} from "../../../src/config/catalogs.ts";
import { getValidator } from "../../../src/config/index.ts";

const PIN = "a".repeat(64);

describe("resolveCatalogs", () => {
  test("with no block, reads NimbleBrain's listing at the plugin catalog URL", () => {
    const [only, ...rest] = resolveCatalogs(undefined, { env: {} });
    expect(rest).toEqual([]);
    expect(only?.name).toBe("nimblebrain");
    expect(only?.policy).toBe("available");
    expect(only?.source).toEqual({
      kind: "url",
      url: "https://catalog.nimblebrain.ai/.well-known/ai-catalog.json",
    });
    expect(only?.refreshMs).toBe(15 * 60_000);
  });

  test("the default follows NB_PLUGIN_CATALOG_URL", () => {
    expect(defaultCatalogs({ NB_PLUGIN_CATALOG_URL: "https://catalog.example.com/" })).toEqual([
      { source: "https://catalog.example.com/.well-known/ai-catalog.json", policy: "available" },
    ]);
  });

  test("an empty list offers nothing", () => {
    expect(resolveCatalogs([])).toEqual([]);
  });

  test("a required catalog without a pin is refused", () => {
    expect(() =>
      resolveCatalogs([{ source: "https://catalog.example.com/ai.json", policy: "required" }]),
    ).toThrow(/required catalog must be pinned/);
  });

  test("a required catalog with a pin resolves, never refreshing on a timer", () => {
    const [c] = resolveCatalogs([
      { source: "https://catalog.example.com/ai.json", policy: "required", sha256: PIN },
    ]);
    expect(c?.sha256).toBe(PIN);
    expect(c?.name).toBe("example");
  });

  test("a malformed pin is refused", () => {
    expect(() =>
      resolveCatalogs([
        { source: "https://c.example.com/a.json", policy: "available", sha256: "xyz" },
      ]),
    ).toThrow(/sha256/);
  });

  test("http is refused off loopback and allowed to it", () => {
    expect(() =>
      resolveCatalogs([{ source: "http://c.example.com/a.json", policy: "available" }]),
    ).toThrow(/must be https/);
    const [c] = resolveCatalogs([{ source: "http://127.0.0.1:8080/a.json", policy: "available" }]);
    expect(c?.source.kind).toBe("url");
  });

  test("a relative path resolves against the config file's directory", () => {
    const [c] = resolveCatalogs([{ source: "catalogs/local", policy: "available" }], {
      configPath: "/etc/nimblebrain/nimblebrain.json",
    });
    expect(c?.source).toEqual({ kind: "path", path: "/etc/nimblebrain/catalogs/local" });
    expect(c?.name).toBe("local");
  });

  test("two catalogs of one derived name are refused until one is named", () => {
    const two: CatalogConfig[] = [
      { source: "https://catalog.acme.com/a.json", policy: "available" },
      { source: "https://staging.acme.com/a.json", policy: "available" },
    ];
    expect(() => resolveCatalogs(two)).toThrow(/give one a distinct "name"/);
    const named = resolveCatalogs([
      two[0] as CatalogConfig,
      { ...(two[1] as CatalogConfig), name: "acme-staging" },
    ]);
    expect(named.map((c) => c.name)).toEqual(["acme", "acme-staging"]);
  });

  test("the same source twice is refused", () => {
    const one = { source: "https://catalog.acme.com/a.json", policy: "available" as const };
    expect(() => resolveCatalogs([one, { ...one, name: "other" }])).toThrow(/listed twice/);
  });

  test("the connector list's catalog name is reserved", () => {
    expect(() => resolveCatalogs([{ source: "/srv/curated", policy: "available" }])).toThrow(
      /reserved/,
    );
  });

  test("refreshMinutes sets the interval and is bounded", () => {
    const [c] = resolveCatalogs([
      { source: "https://catalog.acme.com/a.json", policy: "available", refreshMinutes: 5 },
    ]);
    expect(c?.refreshMs).toBe(5 * 60_000);
    expect(() =>
      resolveCatalogs([
        { source: "https://c.acme.com/a.json", policy: "available", refreshMinutes: 0 },
      ]),
    ).toThrow(/refreshMinutes/);
  });
});

describe("deriveCatalogName", () => {
  test.each([
    ["https://catalog.nimblebrain.ai/.well-known/ai-catalog.json", "nimblebrain"],
    ["https://catalog.example-vendor.com/ai-catalog.json", "example-vendor"],
    ["http://localhost:9000/ai-catalog.json", "localhost"],
    ["http://127.0.0.1:9000/ai-catalog.json", "127-0-0-1"],
  ])("%s is %s", (url, name) => {
    expect(deriveCatalogName({ kind: "url", url })).toBe(name);
  });

  test.each([
    ["/etc/nimblebrain/catalogs/local", "local"],
    ["/etc/nimblebrain/catalogs/vendor.json", "vendor"],
    ["/srv/acme/ai-catalog.json", "acme"],
    ["/srv/acme/.well-known/ai-catalog.json", "acme"],
  ])("%s is %s", (path, name) => {
    expect(deriveCatalogName({ kind: "path", path })).toBe(name);
  });
});

describe("config schema: catalogs", () => {
  const valid = (catalogs: unknown) => getValidator()({ catalogs });

  test("refuses a required catalog without sha256 at validation", () => {
    expect(valid([{ source: "https://c.example.com/a.json", policy: "required" }])).toBe(false);
    expect(
      valid([{ source: "https://c.example.com/a.json", policy: "required", sha256: PIN }]),
    ).toBe(true);
  });

  test("accepts an available catalog without a pin", () => {
    expect(valid([{ source: "/etc/nimblebrain/catalogs/local", policy: "available" }])).toBe(true);
  });

  test("refuses an unknown policy", () => {
    expect(valid([{ source: "/x", policy: "always" }])).toBe(false);
  });
});
