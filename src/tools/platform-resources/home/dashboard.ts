import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/bundles/home/ui && bun install && bun run build</p></body></html>";

const UI_PATH = resolve(
  import.meta.dirname ?? __dirname,
  "../../../bundles/home/ui/dist/index.html",
);

/**
 * Read the home bundle's built UI HTML on each call. Used by
 * `platform/home.ts` as the `text` callback on the `ui://home/dashboard`
 * resource — the in-process app dispatcher awaits this on every
 * `resources/read`, so a developer can rebuild the bundle (`bun run
 * build:bundles`) and hot-reload the iframe without restarting the
 * platform.
 */
export async function loadHomeUi(): Promise<string> {
  if (existsSync(UI_PATH)) return readFileSync(UI_PATH, "utf-8");
  return FALLBACK_HTML;
}
