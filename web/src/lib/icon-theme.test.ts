import { describe, expect, test } from "bun:test";
import { themedIconVariants } from "./icon-theme";

const BASE = "https://static.nimblebrain.ai/logos/github";
const PAIR = { light: `${BASE}/light.svg`, dark: `${BASE}/dark.svg` };

describe("themedIconVariants", () => {
  test("returns both variants for a light-variant URL", () => {
    expect(themedIconVariants(`${BASE}/light.svg`)).toEqual(PAIR);
  });

  test("returns both variants for a dark-variant URL", () => {
    expect(themedIconVariants(`${BASE}/dark.svg`)).toEqual(PAIR);
  });

  test("handles a hyphenated slug", () => {
    expect(
      themedIconVariants("https://static.nimblebrain.ai/logos/google-drive/light.svg"),
    ).toEqual({
      light: "https://static.nimblebrain.ai/logos/google-drive/light.svg",
      dark: "https://static.nimblebrain.ai/logos/google-drive/dark.svg",
    });
  });

  test("has no variants for a legacy flat PNG", () => {
    expect(themedIconVariants("https://static.nimblebrain.ai/icons/slack.png")).toBeUndefined();
  });

  test("has no variants for a registry / third-party URL", () => {
    expect(themedIconVariants("https://cdn.example.com/icon.svg")).toBeUndefined();
  });

  test("does not match non-variant filenames under a slug", () => {
    expect(themedIconVariants(`${BASE}/icon-128.png`)).toBeUndefined();
  });

  test("passes through undefined", () => {
    expect(themedIconVariants(undefined)).toBeUndefined();
  });
});
