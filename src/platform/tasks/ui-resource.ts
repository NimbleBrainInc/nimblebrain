import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/platform/tasks/ui && npm install && npm run build</p></body></html>";

function loadPanelHtml(): string {
  const built = resolve(import.meta.dirname ?? __dirname, "./ui/dist/index.html");
  if (existsSync(built)) {
    return readFileSync(built, "utf-8");
  }
  return FALLBACK_HTML;
}

/** The panel's placement: the scheduled tasks page in the sidebar. */
export const TASKS_PANEL_URI = "ui://tasks/panel";
/** The card chat shows under a `tasks__create` call: the task it saved. */
export const TASKS_CARD_URI = "ui://tasks/card";

/** Pre-loaded panel HTML (read once at import time). */
export const TASKS_PANEL_HTML: string = loadPanelHtml();

/**
 * The same bundle, marked as the card. The app reads the mark to pick its view
 * (`ui/src/App.tsx`, `viewOf`), so one build serves both resources.
 */
export function cardHtml(panelHtml: string): string {
  const mark = '<meta name="nb-tasks-view" content="card">';
  return panelHtml.includes("<head>")
    ? panelHtml.replace("<head>", `<head>${mark}`)
    : `${mark}${panelHtml}`;
}

export const TASKS_CARD_HTML: string = cardHtml(TASKS_PANEL_HTML);
