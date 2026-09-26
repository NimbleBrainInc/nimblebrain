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
import { mergePalette } from "../../../web/src/theme/brand.ts";
import { contrastRatio } from "../../../web/src/theme/contrast.ts";
import {
  colors,
  extOnlyColors,
  fonts,
  radiusScale,
} from "../../../web/src/theme/palette.ts";
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

  test("rejects url and faces together", () => {
    const { ok } = validate({
      fonts: {
        mono: {
          stack: "'Plex', monospace",
          family: "Plex",
          url: "https://static.example.com/a.woff2",
          faces: [{ url: "https://static.example.com/b.woff2", weight: "600" }],
        },
      },
    });
    expect(ok).toBe(false);
  });

  test("requires family whenever a file is declared", () => {
    expect(
      validate({ fonts: { sans: { stack: "x", url: "https://static.example.com/a.woff2" } } }).ok,
    ).toBe(false);
    expect(
      validate({ fonts: { sans: { stack: "x", faces: [{ url: "https://s.example/a.woff2" }] } } })
        .ok,
    ).toBe(false);
  });

  test("accepts a system font: stack only", () => {
    expect(validate({ fonts: { reading: { stack: "Georgia, serif" } } }).ok).toBe(true);
  });

  test("rejects a colour that is not #rrggbb", () => {
    expect(validate({ colors: { primary: ["red", "#000000"] } }).ok).toBe(false);
  });

  /**
   * The schema hand-lists the overridable tokens so editors can complete them.
   * That list is a copy of the palette's names, so it is pinned here: a token
   * added to `palette.ts` fails until the schema offers it too.
   */
  test("brand.colors lists exactly the palette's settable tokens", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "../../../src/config/nimblebrain-config.schema.json"),
        "utf8",
      ),
    );
    const brandSchema = schema.properties.brand.properties;
    const settable = [...Object.keys(colors), ...Object.keys(extOnlyColors)].filter(
      (k) => !k.endsWith("-tint"),
    );
    expect(Object.keys(brandSchema.colors.properties).sort()).toEqual(settable.sort());
    expect(Object.keys(brandSchema.fonts.properties).sort()).toEqual(Object.keys(fonts).sort());
    expect(Object.keys(brandSchema.radius.properties).map((s) => `--border-radius-${s}`)).toEqual(
      Object.keys(radiusScale).filter((k) => k.startsWith("--border-radius-")),
    );
  });
});

describe("mergePalette", () => {
  test("with no brand, returns the canonical palette unchanged", () => {
    const merged = mergePalette();
    expect(merged.colors).toEqual({ ...colors });
    expect(merged.extOnlyColors).toEqual({ ...extOnlyColors });
    expect(merged.fonts).toEqual({ ...fonts });
    expect(merged.radiusScale).toEqual({ ...radiusScale });
  });

  test("derives an omitted <x>-foreground as white or black by contrast against the new base", () => {
    const merged = mergePalette({ colors: { primary: ["#1d4ed8", "#bfdbfe"] } });
    expect(merged.colors["primary-foreground"]).toEqual(["#ffffff", "#000000"]);
  });

  test("keeps a supplied foreground", () => {
    const merged = mergePalette({ colors: ACME_BRAND.colors });
    expect(merged.colors["primary-foreground"]).toEqual(["#FFFFFF", "#1B1B1F"]);
  });

  test("recomputes the translucent tints from the merged source", () => {
    const merged = mergePalette({ colors: ACME_BRAND.colors });
    expect(merged.colors["foreground-tint"]).toEqual([
      "rgba(27, 27, 31, 0.1)",
      "rgba(243, 237, 226, 0.1)",
    ]);
  });

  test("overrides font stacks and the radius scale", () => {
    const merged = mergePalette(ACME_BRAND);
    expect(merged.fonts.heading).toBe("'Syne', system-ui, sans-serif");
    expect(merged.fonts.reading).toBe("'Fraunces', Georgia, serif");
    expect(merged.radiusScale["--border-radius-xs"]).toBe("0");
    expect(merged.radiusScale["--border-radius-xl"]).toBe("0.5rem");
    expect(merged.radiusScale["--border-width-regular"]).toBe("1px");
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

  test("normalises every font role to a faces list", () => {
    const fontsOut = loadBrand({ brand: ACME_BRAND }).fonts;
    expect(fontsOut?.sans).toEqual({
      stack: "'Instrument Sans', system-ui, sans-serif",
      family: "Instrument Sans",
      faces: [
        {
          url: "https://static.example.com/brands/acme/fonts/instrument-sans-latin-wght-normal.woff2",
          weight: "400 700",
        },
      ],
    });
    expect(fontsOut?.mono?.faces).toHaveLength(2);
    for (const font of Object.values(fontsOut ?? {})) {
      expect(font).not.toHaveProperty("url");
      expect(font).not.toHaveProperty("weight");
    }
  });

  test("a system-font role carries no faces", () => {
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

  test("rejects a brand whose canonical status colour fails on the brand's own ground", () => {
    // Canonical success clears AA on white, not over its own tint on ACME paper.
    const { success: _success, ...rest } = ACME_BRAND.colors ?? {};
    expect(() => loadBrand({ brand: { ...ACME_BRAND, colors: rest } })).toThrow(
      "light mode: success on success/10 over background",
    );
  });

  test("rejects url and faces together, and a non-woff2 url", () => {
    const both: Brand = {
      fonts: {
        mono: {
          stack: "x",
          family: "x",
          url: "https://s.example/a.woff2",
          faces: [{ url: "https://s.example/b.woff2" }],
        },
      },
    };
    expect(() => loadBrand({ brand: both })).toThrow("sets both url and faces");
    const css: Brand = {
      fonts: { sans: { stack: "x", family: "x", url: "https://fonts.googleapis.com/css2?x" } },
    };
    expect(() => loadBrand({ brand: css })).toThrow("is not a .woff2 file");
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
