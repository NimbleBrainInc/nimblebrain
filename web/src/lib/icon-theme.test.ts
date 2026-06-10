import { describe, expect, test } from "bun:test";
import { themedIconUrl } from "./icon-theme";

const BASE = "https://static.nimblebrain.ai/logos/github";

describe("themedIconUrl", () => {
  test("swaps to the dark variant in dark mode", () => {
    expect(themedIconUrl(`${BASE}/light.svg`, "dark")).toBe(`${BASE}/dark.svg`);
  });

  test("swaps to the light variant in light mode", () => {
    expect(themedIconUrl(`${BASE}/dark.svg`, "light")).toBe(`${BASE}/light.svg`);
  });

  test("is a no-op when the variant already matches the mode", () => {
    expect(themedIconUrl(`${BASE}/light.svg`, "light")).toBe(`${BASE}/light.svg`);
    expect(themedIconUrl(`${BASE}/dark.svg`, "dark")).toBe(`${BASE}/dark.svg`);
  });

  test("handles a hyphenated slug", () => {
    const u = "https://static.nimblebrain.ai/logos/google-drive/light.svg";
    expect(themedIconUrl(u, "dark")).toBe(
      "https://static.nimblebrain.ai/logos/google-drive/dark.svg",
    );
  });

  test("leaves legacy flat PNGs unchanged", () => {
    const u = "https://static.nimblebrain.ai/icons/slack.png";
    expect(themedIconUrl(u, "dark")).toBe(u);
  });

  test("leaves mpak / third-party URLs unchanged", () => {
    const u = "https://cdn.example.com/icon.svg";
    expect(themedIconUrl(u, "dark")).toBe(u);
  });

  test("does not match non-variant filenames under a slug", () => {
    const u = `${BASE}/icon-128.png`;
    expect(themedIconUrl(u, "dark")).toBe(u);
  });

  test("passes through undefined", () => {
    expect(themedIconUrl(undefined, "dark")).toBeUndefined();
  });
});
