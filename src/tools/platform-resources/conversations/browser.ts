import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/bundles/conversations/ui && bun install && bun run build</p></body></html>";

const UI_PATH = resolve(
  import.meta.dirname ?? __dirname,
  "../../../bundles/conversations/ui/dist/index.html",
);

/**
 * Read the conversations bundle's built UI HTML on each call. See
 * `platform-resources/home/dashboard.ts` for rationale (per-request read
 * enables hot reload after `bun run build:bundles` without a platform
 * restart).
 */
export async function loadConversationsUi(): Promise<string> {
  if (existsSync(UI_PATH)) return readFileSync(UI_PATH, "utf-8");
  return FALLBACK_HTML;
}
