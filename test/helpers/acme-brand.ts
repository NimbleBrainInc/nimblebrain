import type { Brand } from "../../src/brand/index.ts";

/**
 * A complete brand block for a fictional ACME deployment: every key the schema
 * accepts set, with an accent far from the canonical one (burnt orange) so a
 * test proves the merge rather than the default. The same block the branding
 * docs show.
 */
export const ACME_BRAND: Brand = {
  name: "ACME",
  homepageUrl: "https://acme.example",
  defaultTheme: "light",
  logo: {
    light: "https://static.example.com/brands/acme/logo-light.svg",
    dark: "https://static.example.com/brands/acme/logo-dark.svg",
    mark: "https://static.example.com/brands/acme/mark.svg",
    raster: "https://static.example.com/brands/acme/mark-128.png",
  },
  favicon: "https://static.example.com/brands/acme/favicon.png",
  colors: {
    primary: ["#B53707", "#FF8A4C"],
    ring: ["#B53707", "#FF8A4C"],
  },
  fonts: {
    heading: {
      stack: "'Syne', system-ui, sans-serif",
      family: "Syne",
      url: "https://static.example.com/brands/acme/fonts/syne-latin-wght-normal.woff2",
      weight: "400 800",
    },
    sans: {
      stack: "'Instrument Sans', system-ui, sans-serif",
      family: "Instrument Sans",
      url: "https://static.example.com/brands/acme/fonts/instrument-sans-latin-wght-normal.woff2",
      weight: "400 700",
    },
    reading: {
      stack: "'Fraunces', Georgia, serif",
      family: "Fraunces",
      url: "https://static.example.com/brands/acme/fonts/fraunces-latin-wght-normal.woff2",
      weight: "300 700",
    },
  },
};
