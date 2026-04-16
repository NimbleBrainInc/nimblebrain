import { BRIDGE_HELPER } from "./_bridge.ts";

export const SETTINGS_LINK_SCRIPT =
  BRIDGE_HELPER +
  `
const app = document.getElementById("app");
app.innerHTML = '<div class="link">\\u2699\\uFE0F Settings</div>';
app.addEventListener("click", () => navigate("/app/settings"));
`;
