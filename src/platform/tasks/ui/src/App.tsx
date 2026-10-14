import { AppProvider } from "@nimblebrain/synapse/react";
import { TasksUI } from "./components/TasksUI.tsx";
import { STYLES } from "./styles.ts";

export function App() {
  return (
    <AppProvider name="tasks" version="0.1.0" forwardKeys>
      <style>{STYLES}</style>
      <TasksUI />
    </AppProvider>
  );
}
