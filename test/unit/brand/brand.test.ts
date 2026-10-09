import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Brand,
  BrandConfigError,
  brandName,
  DEFAULT_OAUTH_CLIENT_IDENTITY,
  loadBrand,
  oauthClientIdentity,
  resolvedBrand,
} from "../../../src/brand/index.ts";
import { getValidator } from "../../../src/config/index.ts";
import {
  BRAND_COLOR_TOKENS,
  BRAND_FONT_ROLES,
  mergePalette,
} from "../../../web/src/theme/brand.ts";
import { contrastRatio } from "../../../web/src/theme/contrast.ts";
import { colors, extOnlyColors, fonts } from "../../../web/src/theme/palette.ts";
import { ACME_BRAND } from "../../helpers/acme-brand.ts";

afterEach(() => {
  loadBrand({});
});

function validate(brand: unknown) {
  const v = getValidator();
  const ok = v({ version: "1", brand });
  return { ok, errors: v.errors ?? [] };
}

describe("brand schema", () => {
  test("installs defaultTheme as given; absent stays absent, which is system", () => {
    expect(loadBrand({ brand: { defaultTheme: "light" } }).defaultTheme).toBe("light");
    expect(loadBrand({ brand: { name: "ACME" } }).defaultTheme).toBeUndefined();
  });

  test("accepts the full ACME block with no errors and no unknown-key warnings", () => {
    const { ok, errors } = validate(ACME_BRAND);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  test("rejects a Google Fonts stylesheet URL as a font url", () => {
    const { ok } = validate({
      fonts: {
        sans: {
          stack: "'Inter', sans-serif",
          family: "Inter",
          url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;700",
        },
      },
    });
    expect(ok).toBe(false);
  });

  test("flags radius, a mono role, faces and an unsupported colour as unknown keys", () => {
    const { errors } = validate({
      colors: { primary: ["#B53707", "#FF8A4C"], success: ["#0D6B45", "#3fbf85"] },
      fonts: {
        mono: { stack: "ui-monospace, monospace" },
        sans: { stack: "x", faces: [{ url: "https://static.example.com/a.woff2" }] },
      },
      radius: { md: "0.25rem" },
    });
    const unknown = errors
      .filter((e) => e.keyword === "additionalProperties")
      .map((e) => (e.params as { additionalProperty: string }).additionalProperty)
      .sort();
    expect(unknown).toEqual(["faces", "mono", "radius", "success"]);
    expect(errors.filter((e) => e.keyword !== "additionalProperties")).toEqual([]);
  });

  test("weight needs url", () => {
    expect(validate({ fonts: { sans: { stack: "x", weight: "400" } } }).ok).toBe(false);
  });

  test("requires family whenever a url is declared", () => {
    expect(
      validate({ fonts: { sans: { stack: "x", url: "https://static.example.com/a.woff2" } } }).ok,
    ).toBe(false);
  });

  test("accepts a system font: stack only", () => {
    expect(validate({ fonts: { reading: { stack: "Georgia, serif" } } }).ok).toBe(true);
  });

  test("defaultTheme is light, dark or system", () => {
    expect(validate({ defaultTheme: "light" }).ok).toBe(true);
    expect(validate({ defaultTheme: "sepia" }).ok).toBe(false);
  });

  test("rejects a colour that is not #rrggbb", () => {
    expect(validate({ colors: { primary: ["red", "#000000"] } }).ok).toBe(false);
  });

  /**
   * The schema lists the colours and font roles a brand may set so editors can
   * complete them, and the types list the same ones. Pinned here so the two
   * cannot drift.
   */
  test("brand.colors and brand.fonts list exactly what the Brand type allows", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "../../../src/config/nimblebrain-config.schema.json"),
        "utf8",
      ),
    );
    const brandSchema = schema.properties.brand.properties;
    expect(Object.keys(brandSchema.colors.properties).sort()).toEqual(
      [...BRAND_COLOR_TOKENS].sort(),
    );
    expect(Object.keys(brandSchema.fonts.properties).sort()).toEqual([...BRAND_FONT_ROLES].sort());
  });
});

describe("mergePalette", () => {
  test("with no brand, returns the canonical palette unchanged", () => {
    const merged = mergePalette();
    expect(merged.colors).toEqual({ ...colors });
    expect(merged.extOnlyColors).toEqual({ ...extOnlyColors });
    expect(merged.fonts).toEqual({ ...fonts });
  });

  test("derives primary-foreground as white or black by contrast against the brand primary", () => {
    const merged = mergePalette({ colors: { primary: ["#1d4ed8", "#bfdbfe"] } });
    expect(merged.colors["primary-foreground"]).toEqual(["#ffffff", "#000000"]);
  });

  test("ignores tokens and roles a brand may not set", () => {
    const merged = mergePalette({
      colors: { success: ["#000000", "#ffffff"] },
      fonts: { mono: { stack: "x" } },
    } as never);
    expect(merged.colors.success).toEqual(colors.success);
    expect(merged.fonts.mono).toBe(fonts.mono);
  });

  test("overrides the brand's font stacks and keeps the canonical mono", () => {
    const merged = mergePalette(ACME_BRAND);
    expect(merged.fonts.heading).toBe("'Syne', system-ui, sans-serif");
    expect(merged.fonts.reading).toBe("'Fraunces', Georgia, serif");
    expect(merged.fonts.mono).toBe(fonts.mono);
  });
});

describe("loadBrand", () => {
  test("absent brand resolves to {} and the NimbleBrain name", () => {
    expect(loadBrand({})).toEqual({});
    expect(resolvedBrand()).toEqual({});
    expect(brandName()).toBe("NimbleBrain");
    expect(oauthClientIdentity()).toEqual(DEFAULT_OAUTH_CLIENT_IDENTITY);
  });

  test("accepts the full ACME block: every contrast pair passes in both modes", () => {
    const resolved = loadBrand({ brand: ACME_BRAND });
    expect(resolved.name).toBe("ACME");
    expect(brandName()).toBe("ACME");
    expect(resolved.colors).toEqual(ACME_BRAND.colors);
  });

  test("serves fonts in the shape the config wrote them", () => {
    const fontsOut = loadBrand({ brand: ACME_BRAND }).fonts;
    expect(fontsOut).toEqual(ACME_BRAND.fonts);
  });

  test("drops keys the schema does not define, as the config loader reports them", () => {
    const resolved = loadBrand({
      brand: {
        name: "ACME",
        colors: { primary: ["#B53707", "#FF8A4C"], success: ["#000000", "#000000"] },
        fonts: { mono: { stack: "x" }, sans: { stack: "x", faces: [] } },
        radius: { md: "0" },
      } as never,
    });
    expect(resolved).toEqual({
      name: "ACME",
      colors: { primary: ["#B53707", "#FF8A4C"] },
      fonts: { sans: { stack: "x" } },
    });
  });

  test("a system-font role is its stack alone", () => {
    const resolved = loadBrand({ brand: { fonts: { reading: { stack: "Georgia, serif" } } } });
    expect(resolved.fonts?.reading).toEqual({ stack: "Georgia, serif" });
  });

  test("rejects a light primary that fails on white, naming the pair and ratio", () => {
    const brand: Brand = { colors: { primary: ["#CCCCCC", "#6a8fe4"] } };
    const ratio = contrastRatio("#CCCCCC", "#ffffff").toFixed(2);
    expect(() => loadBrand({ brand })).toThrow(BrandConfigError);
    expect(() => loadBrand({ brand })).toThrow(
      `light mode: primary on background (links, accent text) is ${ratio}:1`,
    );
    // A rejected brand installs nothing.
    expect(resolvedBrand()).toEqual({});
  });

  test("rejects a non-woff2 url, and a url without a family", () => {
    const css: Brand = {
      fonts: { sans: { stack: "x", family: "x", url: "https://fonts.googleapis.com/css2?x" } },
    };
    expect(() => loadBrand({ brand: css })).toThrow("is not a .woff2 file");
    const noFamily: Brand = { fonts: { sans: { stack: "x", url: "https://s.example/a.woff2" } } };
    expect(() => loadBrand({ brand: noFamily })).toThrow("sets a url but no family");
  });

  test("OAuth identity uses the brand's name, homepage and raster logo", () => {
    loadBrand({ brand: ACME_BRAND });
    expect(oauthClientIdentity()).toEqual({
      name: "ACME",
      clientUri: "https://acme.example",
      logoUri: "https://static.example.com/brands/acme/mark-128.png",
    });
  });

  test("a named brand without a homepage or raster sends neither", () => {
    loadBrand({ brand: { name: "ACME" } });
    expect(oauthClientIdentity()).toEqual({ name: "ACME" });
  });
});
