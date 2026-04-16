import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/bundles/automations/ui && npm install && npm run build</p></body></html>";

function loadPanelHtml(): string {
  const built = resolve(
    import.meta.dirname ?? __dirname,
    "../../../bundles/automations/ui/dist/index.html",
  );
  if (existsSync(built)) {
    return readFileSync(built, "utf-8");
  }
  return FALLBACK_HTML;
}

/** Pre-loaded Automations panel HTML (read once at import time). */
export const AUTOMATIONS_PANEL_HTML: string = loadPanelHtml();
