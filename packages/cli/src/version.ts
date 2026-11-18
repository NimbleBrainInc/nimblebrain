import pkg from "../package.json" with { type: "json" };

/**
 * This CLI's own version. The CLI is released on its own (`cli/v*` tags,
 * ADR-0064), so this says nothing about which runtime it installs; `status`
 * reports both.
 */
export const VERSION: string = pkg.version;
