import { AppProvider } from "@nimblebrain/synapse/react";
import { Dashboard } from "./Dashboard";

export function App() {
  return (
    <AppProvider name="@nimblebraininc/conversations" version="0.4.0" forwardKeys>
      <Dashboard />
    </AppProvider>
  );
}
