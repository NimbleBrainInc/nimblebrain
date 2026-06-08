import { SynapseProvider } from "@nimblebrain/synapse/react";
import { Dashboard } from "./Dashboard";

export function App() {
  return (
    <SynapseProvider name="@nimblebraininc/conversations" version="0.4.0">
      <Dashboard />
    </SynapseProvider>
  );
}
