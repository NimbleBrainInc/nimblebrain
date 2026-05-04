import { SynapseProvider } from "@nimblebrain/synapse/react";
import { Dashboard } from "./Dashboard";

export function App() {
  return (
    <SynapseProvider name="@nimblebraininc/files" version="1.0.0">
      <Dashboard />
    </SynapseProvider>
  );
}
