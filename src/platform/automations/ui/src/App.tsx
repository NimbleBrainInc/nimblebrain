import { AppProvider } from "@nimblebrain/synapse/react";
import { AutomationsUI } from "./components/AutomationsUI.tsx";
import { STYLES } from "./styles.ts";

export function App() {
  return (
    <AppProvider name="automations" version="0.1.0" forwardKeys>
      <style>{STYLES}</style>
      <AutomationsUI />
    </AppProvider>
  );
}
