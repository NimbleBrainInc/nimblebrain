import type { Brand } from "../../src/brand/index.ts";

/**
 * A complete brand block for a fictional ACME deployment: every overridable
 * surface set, deliberately far from the canonical palette (warm paper, burnt
 * orange, square corners) so a test proves the merge rather than the default.
 * The same block the branding docs show.
 */
export const ACME_BRAND: Brand = {
  name: "ACME",
  homepageUrl: "https://acme.example",
  logo: {
    light: "https://static.example.com/brands/acme/logo-light.svg",
    dark: "https://static.example.com/brands/acme/logo-dark.svg",
    mark: "https://static.example.com/brands/acme/mark.svg",
    raster: "https://static.example.com/brands/acme/mark-128.png",
  },
  favicon: "https://static.example.com/brands/acme/favicon.png",
  colors: {
    background: ["#FAF6EE", "#141210"],
    foreground: ["#1B1B1F", "#F3EDE2"],
    card: ["#FFFCF5", "#1C1916"],
    "card-foreground": ["#1B1B1F", "#F3EDE2"],
    popover: ["#FFFCF5", "#1C1916"],
    "popover-foreground": ["#1B1B1F", "#F3EDE2"],
    primary: ["#B53707", "#FF8A4C"],
    "primary-foreground": ["#FFFFFF", "#1B1B1F"],
    secondary: ["#F0E9DB", "#26221D"],
    "secondary-foreground": ["#1B1B1F", "#F3EDE2"],
    muted: ["#F0E9DB", "#26221D"],
    "muted-foreground": ["#5F5A52", "#A8A196"],
    accent: ["#F0E9DB", "#26221D"],
    "accent-foreground": ["#1B1B1F", "#F3EDE2"],
    border: ["#E3DACA", "#332E28"],
    input: ["#E3DACA", "#332E28"],
    ring: ["#B53707", "#FF8A4C"],
    sidebar: ["#F3EDE1", "#0F0D0B"],
    "sidebar-foreground": ["#5F5A52", "#A8A196"],
    "sidebar-border": ["#E3DACA", "#332E28"],
    "sidebar-hover": ["#EAE2D2", "#1C1916"],
    "info-light": ["#FDEBE0", "#33190C"],
    success: ["#0D6B45", "#3fbf85"],
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
    mono: {
      stack: "'IBM Plex Mono', ui-monospace, monospace",
      family: "IBM Plex Mono",
      faces: [
        {
          url: "https://static.example.com/brands/acme/fonts/ibm-plex-mono-latin-400-normal.woff2",
          weight: "400",
        },
        {
          url: "https://static.example.com/brands/acme/fonts/ibm-plex-mono-latin-600-normal.woff2",
          weight: "600",
        },
      ],
    },
  },
  radius: { xs: "0", sm: "0.125rem", md: "0.25rem", lg: "0.375rem", xl: "0.5rem" },
};
