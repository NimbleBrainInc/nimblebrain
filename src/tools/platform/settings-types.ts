export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  source: "nb" | string;
}

/** Core sections — always present. */
export const CORE_SECTIONS: SettingsSection[] = [
  { id: "profile", label: "Profile", icon: "", source: "nb" },
  { id: "identity", label: "Identity", icon: "", source: "nb" },
  { id: "skills", label: "Skills", icon: "", source: "nb" },
  { id: "bundles", label: "Bundles", icon: "", source: "nb" },
  { id: "model", label: "Model", icon: "", source: "nb" },
  { id: "usage", label: "Usage", icon: "", source: "nb" },
  { id: "system", label: "System", icon: "", source: "nb" },
];

export function renderFragment(styles: string, script: string): string {
  return `<style>${styles}</style><div id="section-root"></div><script>(function(){${script}})()</script>`;
}
