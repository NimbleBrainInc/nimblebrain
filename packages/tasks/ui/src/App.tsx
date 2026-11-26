import { AppProvider } from "@nimblebrain/synapse/react";
import { SavedCard } from "./components/SavedCard.tsx";
import { TasksUI } from "./components/TasksUI.tsx";
import { STYLES } from "./styles.ts";

/**
 * Which view this document is. One bundle serves both resources: the panel
 * (`ui://tasks/panel`) and the card chat shows under `create`
 * (`ui://tasks/card`), which the server marks with `<meta name="nb-tasks-view"
 * content="card">` (the plugin's server injects it).
 */
export function viewOf(mark: string | null | undefined): "panel" | "card" {
  return mark === "card" ? "card" : "panel";
}

/** The view mark's content in this document, or null without one. */
function markOf(doc: Document): string | null {
  return doc.querySelector('meta[name="nb-tasks-view"]')?.getAttribute("content") ?? null;
}

export function App() {
  return (
    <AppProvider name="tasks" version="0.1.0" forwardKeys>
      <style>{STYLES}</style>
      {viewOf(markOf(document)) === "card" ? <SavedCard /> : <TasksUI />}
    </AppProvider>
  );
}
