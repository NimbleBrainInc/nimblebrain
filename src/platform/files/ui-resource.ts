import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/platform/files/ui && bun install && bun run build</p></body></html>";

const UI_PATH = resolve(import.meta.dirname ?? __dirname, "./ui/dist/index.html");

/**
 * Read the files app's built UI HTML on each call. See
 * `platform/home/ui-resource.ts` for rationale (per-request read
 * enables hot reload after `bun run build:platform-apps` without a platform
 * restart).
 */
export async function loadFilesUi(): Promise<string> {
  if (existsSync(UI_PATH)) return readFileSync(UI_PATH, "utf-8");
  return FALLBACK_HTML;
}
