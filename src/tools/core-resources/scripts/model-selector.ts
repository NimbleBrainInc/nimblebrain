import { BRIDGE_HELPER } from "./_bridge.ts";

export const MODEL_SELECTOR_SCRIPT =
  BRIDGE_HELPER +
  `
var app = document.getElementById("app");

function render(currentModel) {
  app.innerHTML = '<input type="text" id="model-input" value="' + (currentModel || '') + '" placeholder="provider:model-id" style="width:100%;padding:4px 8px;font-size:13px;border:1px solid var(--color-border-primary,#e5e5e5);border-radius:4px;background:var(--color-background-primary,#fff);color:var(--color-text-primary,#171717)" />';
  document.getElementById("model-input").addEventListener("change", function(e) {
    var val = e.target.value.trim();
    if (val) callTool("set_model_config", { defaultModel: val });
  });
}

render("");

window.addEventListener("message", function(e) {
  if (e.data && e.data.method === "ui/initialize" && e.data.params && e.data.params.model) {
    render(e.data.params.model);
  }
});
`;
