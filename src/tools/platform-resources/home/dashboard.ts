import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/bundles/home/ui && npm install && npm run build</p></body></html>";

function loadDashboardHtml(): string {
  const built = resolve(
    import.meta.dirname ?? __dirname,
    "../../../bundles/home/ui/dist/index.html",
  );
  if (existsSync(built)) {
    return readFileSync(built, "utf-8");
  }
  return FALLBACK_HTML;
}

/** Pre-loaded Home dashboard HTML (read once at import time). */
export const DASHBOARD_HTML: string = loadDashboardHtml();
