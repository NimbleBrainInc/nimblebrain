import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/bundles/conversations/ui && bun install && bun run build</p></body></html>";

function loadBrowserHtml(): string {
  const built = resolve(
    import.meta.dirname ?? __dirname,
    "../../../bundles/conversations/ui/dist/index.html",
  );
  if (existsSync(built)) {
    return readFileSync(built, "utf-8");
  }
  return FALLBACK_HTML;
}

/** Pre-loaded conversation browser HTML (read once at import time). */
export const BROWSER_HTML: string = loadBrowserHtml();
