import { BRIDGE_HELPER } from "./_bridge.ts";

export const APP_NAV_SCRIPT =
  BRIDGE_HELPER +
  `
const app = document.getElementById("app");

function render(apps) {
  if (!apps.length) { app.innerHTML = '<div class="empty">No apps installed</div>'; return; }
  app.innerHTML = apps.map(a =>
    '<div class="app" data-route="' + (a.route || a.name) + '">' +
    '<span class="app-icon">' + (a.icon || "\\u25A0") + '</span>' +
    '<span class="app-name">' + (a.name || "Unknown") + '</span></div>'
  ).join("");
}

app.addEventListener("click", (e) => {
  const el = e.target.closest(".app");
  if (el) navigate("/app/" + el.dataset.route);
});

async function load() {
  const result = await callTool("list_apps", {});
  const apps = (result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : result) || [];
  render(apps);
}
load();
`;
