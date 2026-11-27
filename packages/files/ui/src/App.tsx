import { AppProvider } from "@nimblebrain/synapse/react";
import { Dashboard } from "./Dashboard";

export function App() {
  return (
    <AppProvider name="@nimblebraininc/files" version="1.0.0" forwardKeys>
      <Dashboard />
    </AppProvider>
  );
}
