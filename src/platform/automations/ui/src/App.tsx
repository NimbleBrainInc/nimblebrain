import { SynapseProvider } from "@nimblebrain/synapse/react";
import { AutomationsUI } from "./components/AutomationsUI.tsx";
import { STYLES } from "./styles.ts";

export function App() {
  return (
    <SynapseProvider name="automations" version="0.1.0">
      <style>{STYLES}</style>
      <AutomationsUI />
    </SynapseProvider>
  );
}
